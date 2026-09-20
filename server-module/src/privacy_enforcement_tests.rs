//! rb-45 — the [DEL-06] crate-wide deletion-gate census (ADR-0258).
//!
//! EARS under gate. (rb-45) WHEN a reducer writes any manifest-classified table
//! without the gate call or `STATE_TRANSITION_OWNERS` membership THE SYSTEM
//! SHALL fail CI. (rb-49, [DEL-06]) WHEN a reducer writes any manifest-classified
//! table outside `STATE_TRANSITION_OWNERS` THE SYSTEM SHALL require a preceding
//! deletion-guard call — a `require_*` wrapper over the rejection predicate,
//! spelled as ADR-0248 D1 pins it — mechanically enforced.
//!
//! OWNERSHIP SPLIT. The `rb45_*` tests and the rosters below are GATING: they are
//! revised from ADR-0258 and the slice plan, NEVER edited to fit an engine. The
//! `census` module is the implementation half; the rest of the file is its contract.
//!
//! FIXTURE HYGIENE — MANDATORY for every future editor. Several eval scripts
//! concatenate the `*_tests.rs` files and scan them as TEXT with string-unaware
//! comment strippers, so a contiguous production marker here reds an unrelated CI
//! gate. Therefore, in this file:
//!   - every production-looking marker inside a fixture is assembled from
//!     `concat!` pieces, spelled ONCE in a `fixture_*` helper or a const near the
//!     top (reducer and table attributes, the accessor spelling, write calls, the
//!     guard paths, the pending predicate, macro and impl-block shapes, the
//!     table-handle type, cfg and path attributes);
//!   - no forward slash inside ANY string literal, no block comment, no raw
//!     string, no include macro, no macro metavariable splice;
//!   - lines stay inside 100 columns and the file stays rustfmt-clean.

use std::collections::BTreeSet;

// ---------------------------------------------------------------------------
// The census engine (implementation half — frozen API, bodies land in T3)
// ---------------------------------------------------------------------------

mod census {
    use std::collections::btree_map::Entry;
    use std::collections::{BTreeMap, BTreeSet, VecDeque};
    use syn::visit::Visit;
    use syn::{Expr, Item, Pat, Stmt};

    pub(super) const WRITE_VERBS: &[&str] = &[
        "insert",
        "try_insert",
        "update",
        "delete",
        "clear",
        "insert_or_update",
        "try_insert_or_update",
    ];

    // --- Vocabulary ---------------------------------------------------------
    // Every name below is compared against an AST ident or path segment. The
    // engine never searches source text: a shape the parser cannot classify is
    // a hard error, never an approximation (ADR-0258 D1).

    const ROOT: &str = "crate";
    const GUARD_MODULE: &str = "guards";
    const ACCOUNT_MODULE: &str = "accounts";
    const SELF_SEGMENT: &str = "self";
    const REQUIRE_NOT_DELETING: &str = "require_not_deleting";
    const REQUIRE_SUBJECT: &str = "require_subject_not_deleting";
    const REQUIRE_COMMITMENT: &str = "require_commitment_predates_deletion";
    const PENDING_PREDICATE: &str = concat!("is_pending_", "deletion");
    const REJECT_PREDICATE: &str = concat!("should_reject_", "for_deletion");
    /// The only three wrapper spellings ADR-0248 D1 pins as gate shape (a).
    const GATE_WRAPPERS: &[&str] = &[REQUIRE_NOT_DELETING, REQUIRE_SUBJECT, REQUIRE_COMMITMENT];
    /// Guard-family fn names that may only be DEFINED in guards or accounts.
    const GUARD_FN_NAMES: &[&str] = &[
        REQUIRE_NOT_DELETING,
        REQUIRE_SUBJECT,
        REQUIRE_COMMITMENT,
        PENDING_PREDICATE,
        REJECT_PREDICATE,
    ];
    const LIFECYCLE_ARGS: &[&str] = &["init", "client_connected", "client_disconnected"];
    /// Chain methods that turn a table handle into rows, so a binding of such a
    /// chain is a row, never a handle alias.
    const ROW_METHODS: &[&str] = &["iter", "count", "len"];
    const HANDLE_SUFFIX: &str = concat!("Table", "Handle");
    const TABLE_TRAIT: &str = "Table";
    const CTX_TYPE: &str = "ReducerContext";
    const TEST_CFG: &str = "test";
    const CFG_ATTR: &str = "cfg";
    const PATH_ATTR: &str = "path";
    const REDUCER_ATTR: &str = "reducer";
    const TABLE_ATTR: &str = "table";
    const PROCEDURE_ATTR: &str = "procedure";
    const SCHEDULED_ARG: &str = "scheduled";
    const LIB_STEM: &str = "lib";
    const SRC_DIR: &str = "src";

    /// Manifest tables whose `DeletionPolicy` is not `NotOwned`, read from the
    /// real `crate::schema::DATA_LIFECYCLE_MANIFEST`.
    pub(super) fn classified_tables() -> BTreeSet<&'static str> {
        crate::schema::DATA_LIFECYCLE_MANIFEST
            .iter()
            .filter(|entry| !matches!(entry.policy, crate::schema::DeletionPolicy::NotOwned))
            .map(|entry| entry.table)
            .collect()
    }

    /// The real corpus: `[("crate", lib.rs source), (module, module source)…]`,
    /// derived by parsing lib.rs and read through `env!("CARGO_MANIFEST_DIR")`.
    pub(super) fn real_sources() -> Result<Vec<(String, String)>, CensusError> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SRC_DIR);
        let root_source = read_module(&dir, LIB_STEM, ROOT)?;
        let root_file = parse_module(ROOT, &root_source)?;
        let mut out = vec![(String::from(ROOT), root_source)];
        for item in &root_file.items {
            let Item::Mod(item_mod) = item else { continue };
            if item_mod.content.is_some() {
                continue;
            }
            if let RootMod::Scanned = classify_root_mod(item_mod)? {
                let name = item_mod.ident.to_string();
                let source = read_module(&dir, &name, &name)?;
                out.push((name, source));
            }
        }
        Ok(out)
    }

    pub(super) fn census(
        sources: &[(String, String)],
        classified: &BTreeSet<&str>,
        owners: &[&str],
    ) -> Result<Report, CensusError> {
        let mut files: Vec<(&str, syn::File)> = Vec::with_capacity(sources.len());
        for (module, source) in sources {
            files.push((module.as_str(), parse_module(module, source)?));
        }
        let corpus = Corpus::collect(&files)?;
        let tables: BTreeSet<String> = classified.iter().map(|t| (*t).to_string()).collect();
        let modules = sources.iter().map(|(name, _)| name.clone()).collect();
        corpus.report(&tables, owners, modules)
    }

    #[derive(Debug)]
    pub(super) struct Report {
        pub verdicts: BTreeMap<String, Verdict>,
        pub modules: Vec<String>,
    }

    impl Report {
        pub(super) fn ungated(&self) -> BTreeSet<&str> {
            self.names_with(|verdict| matches!(verdict, Verdict::Ungated { .. }))
        }

        pub(super) fn names_with(&self, pred: impl Fn(&Verdict) -> bool) -> BTreeSet<&str> {
            self.verdicts
                .iter()
                .filter(|(_, verdict)| pred(verdict))
                .map(|(name, _)| name.as_str())
                .collect()
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) enum Verdict {
        Owner,
        Lifecycle,
        Scheduled,
        NoClassifiedWrites,
        Gated {
            gate_stmt: usize,
            first_write_stmt: usize,
        },
        Ungated {
            writes: BTreeSet<String>,
            first_write_stmt: usize,
            gate_stmt: Option<usize>,
            via: Vec<String>,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) enum CensusError {
        Parse { module: String, msg: String },
        MissingModuleFile { module: String },
        DuplicateReducer { name: String },
        UnsupportedShape { module: String, what: String },
    }

    // --- Source access ------------------------------------------------------

    fn read_module(dir: &std::path::Path, stem: &str, module: &str) -> Result<String, CensusError> {
        std::fs::read_to_string(dir.join(format!("{stem}.rs"))).map_err(|_| {
            CensusError::MissingModuleFile {
                module: String::from(module),
            }
        })
    }

    fn parse_module(module: &str, source: &str) -> Result<syn::File, CensusError> {
        syn::parse_file(source).map_err(|err| CensusError::Parse {
            module: String::from(module),
            msg: err.to_string(),
        })
    }

    fn shape(module: &str, what: String) -> CensusError {
        CensusError::UnsupportedShape {
            module: String::from(module),
            what,
        }
    }

    // --- Crate-root module roster ------------------------------------------

    enum RootMod {
        Scanned,
        Skipped,
    }

    /// A crate-root `mod` is SCANNED when it carries no attribute at all and
    /// SKIPPED when it carries exactly a test cfg (optionally with a path
    /// attribute). Every other attribute set is refused rather than guessed.
    fn classify_root_mod(item_mod: &syn::ItemMod) -> Result<RootMod, CensusError> {
        if item_mod.attrs.is_empty() {
            return Ok(RootMod::Scanned);
        }
        let ident = item_mod.ident.to_string();
        let mut test_gated = false;
        for attr in &item_mod.attrs {
            match attr_name(attr).as_deref() {
                Some(name) if name == CFG_ATTR => {
                    if !is_test_cfg(attr) {
                        return Err(root_mod_error(&ident, true));
                    }
                    test_gated = true;
                }
                Some(name) if name == PATH_ATTR => {}
                _ => return Err(root_mod_error(&ident, false)),
            }
        }
        if test_gated {
            Ok(RootMod::Skipped)
        } else {
            Err(root_mod_error(&ident, false))
        }
    }

    fn root_mod_error(ident: &str, cfg_shaped: bool) -> CensusError {
        let what = if cfg_shaped {
            format!("module {ident} carries a cfg attribute other than the test one")
        } else {
            format!("module {ident} carries an unsupported attribute set at the crate root")
        };
        shape(ROOT, what)
    }

    // --- Attribute helpers --------------------------------------------------

    fn attr_name(attr: &syn::Attribute) -> Option<String> {
        attr.path().segments.last().map(|s| s.ident.to_string())
    }

    fn attr_ident_arg(attr: &syn::Attribute) -> Option<String> {
        match &attr.meta {
            syn::Meta::List(list) => syn::parse2::<syn::Ident>(list.tokens.clone())
                .ok()
                .map(|ident| ident.to_string()),
            _ => None,
        }
    }

    fn is_test_cfg(attr: &syn::Attribute) -> bool {
        attr_ident_arg(attr).is_some_and(|arg| arg == TEST_CFG)
    }

    fn carries_test_cfg(attrs: &[syn::Attribute]) -> bool {
        attrs
            .iter()
            .any(|attr| attr_name(attr).as_deref() == Some(CFG_ATTR) && is_test_cfg(attr))
    }

    /// `Some(attribute argument)` when the item carries a reducer attribute;
    /// the inner `None` is the argument-less spelling.
    fn reducer_arg(attrs: &[syn::Attribute]) -> Option<Option<String>> {
        attrs
            .iter()
            .find(|attr| attr_name(attr).as_deref() == Some(REDUCER_ATTR))
            .map(attr_ident_arg)
    }

    fn item_attrs(item: &Item) -> &[syn::Attribute] {
        match item {
            Item::Const(i) => &i.attrs,
            Item::Enum(i) => &i.attrs,
            Item::ExternCrate(i) => &i.attrs,
            Item::Fn(i) => &i.attrs,
            Item::ForeignMod(i) => &i.attrs,
            Item::Impl(i) => &i.attrs,
            Item::Macro(i) => &i.attrs,
            Item::Mod(i) => &i.attrs,
            Item::Static(i) => &i.attrs,
            Item::Struct(i) => &i.attrs,
            Item::Trait(i) => &i.attrs,
            Item::TraitAlias(i) => &i.attrs,
            Item::Type(i) => &i.attrs,
            Item::Union(i) => &i.attrs,
            Item::Use(i) => &i.attrs,
            _ => &[],
        }
    }

    fn item_label(item: &Item) -> String {
        match item {
            Item::Const(i) => i.ident.to_string(),
            Item::Enum(i) => i.ident.to_string(),
            Item::Fn(i) => i.sig.ident.to_string(),
            Item::Mod(i) => i.ident.to_string(),
            Item::Static(i) => i.ident.to_string(),
            Item::Struct(i) => i.ident.to_string(),
            Item::Trait(i) => i.ident.to_string(),
            Item::Type(i) => i.ident.to_string(),
            Item::Union(i) => i.ident.to_string(),
            _ => String::from("an unnamed item"),
        }
    }

    fn path_segments(path: &syn::Path) -> Vec<String> {
        path.segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect()
    }

    fn path_tail(path: &syn::Path) -> String {
        path.segments
            .last()
            .map_or_else(|| String::from("an unnamed path"), |s| s.ident.to_string())
    }

    fn use_rename(tree: &syn::UseTree) -> Option<String> {
        match tree {
            syn::UseTree::Path(inner) => use_rename(&inner.tree),
            syn::UseTree::Group(group) => group.items.iter().find_map(use_rename),
            syn::UseTree::Rename(rename) => Some(rename.rename.to_string()),
            _ => None,
        }
    }

    // --- Signature probes ---------------------------------------------------

    struct CtxProbe {
        hit: bool,
    }

    impl<'ast> Visit<'ast> for CtxProbe {
        fn visit_path_segment(&mut self, segment: &'ast syn::PathSegment) {
            if segment.ident == CTX_TYPE {
                self.hit = true;
            }
            syn::visit::visit_path_segment(self, segment);
        }
    }

    fn signature_mentions_ctx(sig: &syn::Signature) -> bool {
        let mut probe = CtxProbe { hit: false };
        probe.visit_signature(sig);
        probe.hit
    }

    struct HandleProbe {
        hit: bool,
        depth: usize,
    }

    impl<'ast> Visit<'ast> for HandleProbe {
        fn visit_type_impl_trait(&mut self, node: &'ast syn::TypeImplTrait) {
            self.depth += 1;
            syn::visit::visit_type_impl_trait(self, node);
            self.depth -= 1;
        }

        fn visit_path_segment(&mut self, segment: &'ast syn::PathSegment) {
            let ident = segment.ident.to_string();
            if ident.ends_with(HANDLE_SUFFIX) {
                self.hit = true;
            }
            let parameterised = matches!(segment.arguments, syn::PathArguments::AngleBracketed(_));
            if ident == TABLE_TRAIT && (self.depth > 0 || parameterised) {
                self.hit = true;
            }
            syn::visit::visit_path_segment(self, segment);
        }
    }

    fn returns_handle(output: &syn::ReturnType) -> bool {
        let mut probe = HandleProbe {
            hit: false,
            depth: 0,
        };
        probe.visit_return_type(output);
        probe.hit
    }

    // --- Corpus collection --------------------------------------------------

    struct FnBody {
        module: String,
        name: String,
        block: syn::Block,
        reducer: Option<Option<String>>,
    }

    struct Corpus {
        fns: Vec<FnBody>,
        module_set: BTreeSet<String>,
        scheduled: BTreeSet<String>,
        reducers: BTreeSet<String>,
    }

    impl Corpus {
        fn collect(files: &[(&str, syn::File)]) -> Result<Self, CensusError> {
            let mut corpus = Corpus {
                fns: Vec::new(),
                module_set: files.iter().map(|(name, _)| (*name).to_string()).collect(),
                scheduled: BTreeSet::new(),
                reducers: BTreeSet::new(),
            };
            for (module, file) in files {
                corpus.scan_items(module, &file.items)?;
            }
            Ok(corpus)
        }

        fn scan_items(&mut self, module: &str, items: &[Item]) -> Result<(), CensusError> {
            for item in items {
                self.scan_item(module, item)?;
            }
            Ok(())
        }

        fn scan_item(&mut self, module: &str, item: &Item) -> Result<(), CensusError> {
            for attr in item_attrs(item) {
                if attr_name(attr).as_deref() == Some(PROCEDURE_ATTR) {
                    let what = format!("procedure attribute on {}", item_label(item));
                    return Err(shape(module, what));
                }
            }
            match item {
                Item::Macro(item_macro) => {
                    let what = match &item_macro.ident {
                        Some(ident) => format!("macro definition {ident} at item position"),
                        None => format!(
                            "macro invocation {} at item position",
                            path_tail(&item_macro.mac.path)
                        ),
                    };
                    Err(shape(module, what))
                }
                Item::Mod(item_mod) => self.scan_mod(module, item_mod),
                Item::Use(item_use) => match use_rename(&item_use.tree) {
                    Some(alias) => Err(shape(module, format!("use as rename binding {alias}"))),
                    None => Ok(()),
                },
                Item::Impl(item_impl) => {
                    for inner in &item_impl.items {
                        if let syn::ImplItem::Fn(method) = inner {
                            if signature_mentions_ctx(&method.sig) {
                                let what = format!(
                                    "an implementation block fn {} takes a reducer context",
                                    method.sig.ident
                                );
                                return Err(shape(module, what));
                            }
                        }
                    }
                    Ok(())
                }
                Item::Struct(item_struct) => {
                    self.collect_schedule_targets(&item_struct.attrs);
                    Ok(())
                }
                Item::Fn(item_fn) => self.scan_fn(module, item_fn),
                _ => Ok(()),
            }
        }

        fn scan_mod(&mut self, module: &str, item_mod: &syn::ItemMod) -> Result<(), CensusError> {
            if module == ROOT {
                if let RootMod::Scanned = classify_root_mod(item_mod)? {
                    if let Some((_, inner)) = &item_mod.content {
                        self.scan_items(module, inner)?;
                    }
                }
                return Ok(());
            }
            if carries_test_cfg(&item_mod.attrs) {
                return Ok(());
            }
            let what = format!("nested module {} without a test attribute", item_mod.ident);
            Err(shape(module, what))
        }

        fn scan_fn(&mut self, module: &str, item_fn: &syn::ItemFn) -> Result<(), CensusError> {
            let name = item_fn.sig.ident.to_string();
            if returns_handle(&item_fn.sig.output) {
                return Err(shape(module, format!("fn {name} returns a table handle")));
            }
            if GUARD_FN_NAMES.contains(&name.as_str())
                && module != GUARD_MODULE
                && module != ACCOUNT_MODULE
            {
                let what = format!("shadow definition of the guard fn {name}");
                return Err(shape(module, what));
            }
            let reducer = reducer_arg(&item_fn.attrs);
            if reducer.is_some() && !self.reducers.insert(name.clone()) {
                return Err(CensusError::DuplicateReducer { name });
            }
            self.fns.push(FnBody {
                module: String::from(module),
                name,
                block: (*item_fn.block).clone(),
                reducer,
            });
            Ok(())
        }

        /// The scheduled reducer roster: the ident inside the schedule argument
        /// of any table attribute in the corpus (never the parameter type).
        fn collect_schedule_targets(&mut self, attrs: &[syn::Attribute]) {
            for attr in attrs {
                if attr_name(attr).as_deref() != Some(TABLE_ATTR) {
                    continue;
                }
                let parsed = attr.parse_args_with(
                    syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
                );
                let Ok(args) = parsed else { continue };
                for meta in args {
                    let syn::Meta::List(list) = meta else {
                        continue;
                    };
                    if !list.path.is_ident(SCHEDULED_ARG) {
                        continue;
                    }
                    if let Ok(ident) = syn::parse2::<syn::Ident>(list.tokens.clone()) {
                        self.scheduled.insert(ident.to_string());
                    }
                }
            }
        }
    }

    // --- Crate-local call resolution ---------------------------------------

    struct Resolver {
        index: BTreeMap<(String, String), usize>,
        by_name: BTreeMap<String, Vec<usize>>,
        modules: BTreeSet<String>,
    }

    impl Resolver {
        fn build(fns: &[FnBody], modules: &BTreeSet<String>) -> Self {
            let mut index = BTreeMap::new();
            let mut by_name: BTreeMap<String, Vec<usize>> = BTreeMap::new();
            for (idx, entry) in fns.iter().enumerate() {
                index.insert((entry.module.clone(), entry.name.clone()), idx);
                by_name.entry(entry.name.clone()).or_default().push(idx);
            }
            Resolver {
                index,
                by_name,
                modules: modules.clone(),
            }
        }

        fn in_module(&self, module: &str, name: &str) -> Vec<usize> {
            self.index
                .get(&(String::from(module), String::from(name)))
                .map_or_else(Vec::new, |idx| vec![*idx])
        }

        /// Resolve a call or fn-pointer path to crate fns. Zero matches means a
        /// closure, an `Fn` parameter or a foreign call, which is ignored.
        fn resolve(&self, module: &str, segments: &[String]) -> Vec<usize> {
            let Some(name) = segments.last() else {
                return Vec::new();
            };
            match segments.len() {
                1 => {
                    let same = self.in_module(module, name);
                    if same.is_empty() {
                        self.by_name.get(name).cloned().unwrap_or_default()
                    } else {
                        same
                    }
                }
                2 if segments[0] == SELF_SEGMENT => self.in_module(module, name),
                2 if segments[0] == ROOT => self.in_module(ROOT, name),
                2 if self.modules.contains(segments[0].as_str()) => {
                    self.in_module(&segments[0], name)
                }
                3 if segments[0] == ROOT && self.modules.contains(segments[1].as_str()) => {
                    self.in_module(&segments[1], name)
                }
                _ => Vec::new(),
            }
        }
    }

    // --- Refused body shapes ------------------------------------------------

    struct RefusalProbe<'s> {
        resolver: &'s Resolver,
        module: &'s str,
        fn_name: &'s str,
        found: Option<String>,
    }

    impl<'ast, 's> Visit<'ast> for RefusalProbe<'s> {
        fn visit_local(&mut self, local: &'ast syn::Local) {
            if self.found.is_none() {
                if let (Pat::Ident(binding), Some(init)) = (&local.pat, &local.init) {
                    if let Expr::Path(path) = &*init.expr {
                        let segments = path_segments(&path.path);
                        if !self.resolver.resolve(self.module, &segments).is_empty() {
                            self.found = Some(format!(
                                "fn pointer let binding {} in fn {}",
                                binding.ident, self.fn_name
                            ));
                        }
                    }
                }
            }
            syn::visit::visit_local(self, local);
        }

        fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
            if self.found.is_none() {
                if let Expr::Path(path) = &*call.func {
                    let segments = path_segments(&path.path);
                    if let Some(last) = segments.last() {
                        if segments.len() >= 2 && WRITE_VERBS.contains(&last.as_str()) {
                            self.found =
                                Some(format!("ufcs write call {last} in fn {}", self.fn_name));
                        } else if segments.len() > 3 && segments[0] == ROOT {
                            self.found = Some(format!(
                                "nested module call path to {last} in fn {}",
                                self.fn_name
                            ));
                        }
                    }
                }
            }
            syn::visit::visit_expr_call(self, call);
        }
    }

    // --- Handle aliases -----------------------------------------------------

    struct AliasScan<'s> {
        classified: &'s BTreeSet<String>,
        known: &'s BTreeMap<String, String>,
        found: BTreeMap<String, String>,
    }

    impl<'ast, 's> Visit<'ast> for AliasScan<'s> {
        fn visit_local(&mut self, local: &'ast syn::Local) {
            if let (Pat::Ident(binding), Some(init)) = (&local.pat, &local.init) {
                if binding.subpat.is_none() {
                    if let Some(table) = handle_chain(&init.expr, self.classified, self.known) {
                        self.found.insert(binding.ident.to_string(), table);
                    }
                }
            }
            syn::visit::visit_local(self, local);
        }
    }

    /// A handle chain: it reaches a classified accessor (or a known alias) and
    /// EVERY method call in it is zero-argument and none of them turns the
    /// handle into rows. `ctx.db.battle()` and `ctx.db.battle().battle_id()`
    /// qualify; a `find(..)`-shaped row chain does not.
    fn handle_chain(
        expr: &Expr,
        classified: &BTreeSet<String>,
        known: &BTreeMap<String, String>,
    ) -> Option<String> {
        let mut found: Option<String> = None;
        let mut cursor = expr;
        loop {
            match cursor {
                Expr::MethodCall(call) => {
                    let method = call.method.to_string();
                    if !call.args.is_empty() || ROW_METHODS.contains(&method.as_str()) {
                        return None;
                    }
                    if found.is_none() && classified.contains(method.as_str()) {
                        found = Some(method);
                    }
                    cursor = &call.receiver;
                }
                Expr::Field(field) => cursor = &field.base,
                Expr::Reference(reference) => cursor = &reference.expr,
                Expr::Paren(paren) => cursor = &paren.expr,
                Expr::Try(attempt) => cursor = &attempt.expr,
                Expr::Path(path) => {
                    if found.is_none() {
                        if let Some(ident) = path.path.get_ident() {
                            found = known.get(&ident.to_string()).cloned();
                        }
                    }
                    return found;
                }
                _ => return found,
            }
        }
    }

    fn collect_aliases(
        block: &syn::Block,
        classified: &BTreeSet<String>,
    ) -> BTreeMap<String, String> {
        let mut known: BTreeMap<String, String> = BTreeMap::new();
        loop {
            let found = {
                let mut scan = AliasScan {
                    classified,
                    known: &known,
                    found: BTreeMap::new(),
                };
                scan.visit_block(block);
                scan.found
            };
            let mut grew = false;
            for (name, table) in found {
                if let Entry::Vacant(slot) = known.entry(name) {
                    slot.insert(table);
                    grew = true;
                }
            }
            if !grew {
                return known;
            }
        }
    }

    // --- Writes and calls ---------------------------------------------------

    fn accessor_in_chain(expr: &Expr, classified: &BTreeSet<String>) -> Option<String> {
        match expr {
            Expr::MethodCall(call) => {
                let method = call.method.to_string();
                if call.args.is_empty() && classified.contains(method.as_str()) {
                    return Some(method);
                }
                accessor_in_chain(&call.receiver, classified)
            }
            Expr::Field(field) => accessor_in_chain(&field.base, classified),
            Expr::Reference(reference) => accessor_in_chain(&reference.expr, classified),
            Expr::Paren(paren) => accessor_in_chain(&paren.expr, classified),
            Expr::Try(attempt) => accessor_in_chain(&attempt.expr, classified),
            _ => None,
        }
    }

    /// The alias root of a write receiver: reachable through method receivers,
    /// references and parentheses ONLY — a field base is a row, not a handle.
    fn alias_root(expr: &Expr, aliases: &BTreeMap<String, String>) -> Option<String> {
        match expr {
            Expr::MethodCall(call) => alias_root(&call.receiver, aliases),
            Expr::Reference(reference) => alias_root(&reference.expr, aliases),
            Expr::Paren(paren) => alias_root(&paren.expr, aliases),
            Expr::Path(path) => path
                .path
                .get_ident()
                .and_then(|ident| aliases.get(&ident.to_string()).cloned()),
            _ => None,
        }
    }

    fn write_target(
        receiver: &Expr,
        classified: &BTreeSet<String>,
        aliases: &BTreeMap<String, String>,
    ) -> Option<String> {
        accessor_in_chain(receiver, classified).or_else(|| alias_root(receiver, aliases))
    }

    struct ScanCtx<'s> {
        classified: &'s BTreeSet<String>,
        aliases: &'s BTreeMap<String, String>,
        resolver: &'s Resolver,
        module: &'s str,
    }

    #[derive(Default)]
    struct BodyFacts {
        writes: BTreeSet<String>,
        calls: BTreeSet<usize>,
    }

    struct BodyScan<'s> {
        ctx: &'s ScanCtx<'s>,
        facts: BodyFacts,
    }

    impl<'ast, 's> Visit<'ast> for BodyScan<'s> {
        fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
            let method = call.method.to_string();
            if WRITE_VERBS.contains(&method.as_str()) {
                if let Some(table) =
                    write_target(&call.receiver, self.ctx.classified, self.ctx.aliases)
                {
                    self.facts.writes.insert(table);
                }
            }
            syn::visit::visit_expr_method_call(self, call);
        }

        fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
            if let Expr::Path(path) = &*call.func {
                let segments = path_segments(&path.path);
                for idx in self.ctx.resolver.resolve(self.ctx.module, &segments) {
                    self.facts.calls.insert(idx);
                }
            }
            syn::visit::visit_expr_call(self, call);
        }
    }

    fn scan_block(block: &syn::Block, ctx: &ScanCtx) -> BodyFacts {
        let mut scan = BodyScan {
            ctx,
            facts: BodyFacts::default(),
        };
        scan.visit_block(block);
        scan.facts
    }

    fn scan_stmt(stmt: &Stmt, ctx: &ScanCtx) -> BodyFacts {
        let mut scan = BodyScan {
            ctx,
            facts: BodyFacts::default(),
        };
        scan.visit_stmt(stmt);
        scan.facts
    }

    // --- Gate shapes --------------------------------------------------------

    struct PendingProbe<'s> {
        module: &'s str,
        hit: bool,
    }

    impl<'ast, 's> Visit<'ast> for PendingProbe<'s> {
        fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
            if let Expr::Path(path) = &*call.func {
                let segments = path_segments(&path.path);
                let qualified = segments.len() == 3
                    && segments[0] == ROOT
                    && segments[1] == ACCOUNT_MODULE
                    && segments[2] == PENDING_PREDICATE;
                let bare = segments.len() == 1
                    && segments[0] == PENDING_PREDICATE
                    && self.module == ACCOUNT_MODULE;
                if qualified || bare {
                    self.hit = true;
                }
            }
            syn::visit::visit_expr_call(self, call);
        }
    }

    fn condition_tests_pending(cond: &Expr, module: &str) -> bool {
        let mut probe = PendingProbe { module, hit: false };
        probe.visit_expr(cond);
        probe.hit
    }

    fn wrapper_call(expr: &Expr) -> bool {
        let Expr::Call(call) = expr else { return false };
        let Expr::Path(path) = &*call.func else {
            return false;
        };
        let segments = path_segments(&path.path);
        segments.len() == 3
            && segments[0] == ROOT
            && segments[1] == GUARD_MODULE
            && GATE_WRAPPERS.contains(&segments[2].as_str())
    }

    /// A leading `!` on the condition inverts the test, so the branch guards the
    /// NOT-pending case and is never a gate.
    fn is_negation(cond: &Expr) -> bool {
        match cond {
            Expr::Unary(unary) => matches!(unary.op, syn::UnOp::Not(_)),
            _ => false,
        }
    }

    /// The two gate shapes, at the reducer body's depth 0 and nowhere else.
    fn is_gate(stmt: &Stmt, module: &str) -> bool {
        match stmt {
            Stmt::Expr(Expr::Try(attempt), Some(_)) => wrapper_call(&attempt.expr),
            Stmt::Expr(Expr::If(branch), _) => {
                !is_negation(&branch.cond)
                    && condition_tests_pending(&branch.cond, module)
                    && matches!(
                        branch.then_branch.stmts.last(),
                        Some(Stmt::Expr(Expr::Return(_), _))
                    )
            }
            _ => false,
        }
    }

    // --- The census ---------------------------------------------------------

    impl Corpus {
        fn report(
            &self,
            classified: &BTreeSet<String>,
            owners: &[&str],
            modules: Vec<String>,
        ) -> Result<Report, CensusError> {
            let resolver = Resolver::build(&self.fns, &self.module_set);
            let aliases: Vec<BTreeMap<String, String>> = self
                .fns
                .iter()
                .map(|entry| collect_aliases(&entry.block, classified))
                .collect();
            for entry in &self.fns {
                let mut probe = RefusalProbe {
                    resolver: &resolver,
                    module: &entry.module,
                    fn_name: &entry.name,
                    found: None,
                };
                probe.visit_block(&entry.block);
                if let Some(what) = probe.found {
                    return Err(shape(&entry.module, what));
                }
            }
            let facts: Vec<BodyFacts> = self
                .fns
                .iter()
                .enumerate()
                .map(|(idx, entry)| {
                    let ctx = ScanCtx {
                        classified,
                        aliases: &aliases[idx],
                        resolver: &resolver,
                        module: &entry.module,
                    };
                    scan_block(&entry.block, &ctx)
                })
                .collect();
            let reachable = transitive_writes(&facts);

            let mut verdicts = BTreeMap::new();
            for (idx, entry) in self.fns.iter().enumerate() {
                let Some(argument) = &entry.reducer else {
                    continue;
                };
                let verdict = self.verdict_of(VerdictInput {
                    idx,
                    entry,
                    argument: argument.as_deref(),
                    owners,
                    classified,
                    aliases: &aliases[idx],
                    resolver: &resolver,
                    facts: &facts,
                    reachable: &reachable,
                });
                verdicts.insert(entry.name.clone(), verdict);
            }
            Ok(Report { verdicts, modules })
        }

        fn verdict_of(&self, input: VerdictInput) -> Verdict {
            let name = input.entry.name.as_str();
            if input.owners.contains(&name) {
                return Verdict::Owner;
            }
            if input
                .argument
                .is_some_and(|arg| LIFECYCLE_ARGS.contains(&arg))
            {
                return Verdict::Lifecycle;
            }
            if self.scheduled.contains(name) {
                return Verdict::Scheduled;
            }
            let writes = &input.reachable[input.idx];
            if writes.is_empty() {
                return Verdict::NoClassifiedWrites;
            }
            let ctx = ScanCtx {
                classified: input.classified,
                aliases: input.aliases,
                resolver: input.resolver,
                module: &input.entry.module,
            };
            let first_write_stmt = input
                .entry
                .block
                .stmts
                .iter()
                .position(|stmt| {
                    let facts = scan_stmt(stmt, &ctx);
                    !facts.writes.is_empty()
                        || facts
                            .calls
                            .iter()
                            .any(|callee| !input.reachable[*callee].is_empty())
                })
                .unwrap_or(0);
            let gate_stmt = input
                .entry
                .block
                .stmts
                .iter()
                .position(|stmt| is_gate(stmt, &input.entry.module));
            match gate_stmt {
                Some(gate) if gate < first_write_stmt => Verdict::Gated {
                    gate_stmt: gate,
                    first_write_stmt,
                },
                _ => Verdict::Ungated {
                    writes: writes.clone(),
                    first_write_stmt,
                    gate_stmt,
                    via: self.via_chain(input.idx, input.facts, input.reachable),
                },
            }
        }

        /// The resolved helper chain from a reducer to the first fn that writes
        /// a classified table itself. Empty when the reducer writes directly.
        fn via_chain(
            &self,
            start: usize,
            facts: &[BodyFacts],
            reachable: &[BTreeSet<String>],
        ) -> Vec<String> {
            if !facts[start].writes.is_empty() {
                return Vec::new();
            }
            let mut seen: BTreeSet<usize> = BTreeSet::new();
            seen.insert(start);
            let mut queue: VecDeque<(usize, Vec<String>)> = facts[start]
                .calls
                .iter()
                .map(|callee| (*callee, vec![self.fns[*callee].name.clone()]))
                .collect();
            while let Some((idx, chain)) = queue.pop_front() {
                if !seen.insert(idx) {
                    continue;
                }
                if !facts[idx].writes.is_empty() {
                    return chain;
                }
                if reachable[idx].is_empty() {
                    continue;
                }
                for callee in &facts[idx].calls {
                    let mut next = chain.clone();
                    next.push(self.fns[*callee].name.clone());
                    queue.push_back((*callee, next));
                }
            }
            Vec::new()
        }
    }

    struct VerdictInput<'s> {
        idx: usize,
        entry: &'s FnBody,
        argument: Option<&'s str>,
        owners: &'s [&'s str],
        classified: &'s BTreeSet<String>,
        aliases: &'s BTreeMap<String, String>,
        resolver: &'s Resolver,
        facts: &'s [BodyFacts],
        reachable: &'s [BTreeSet<String>],
    }

    /// Writes(f) = own writes ∪ writes of every crate fn f calls, as a fixpoint
    /// over sets so a call cycle terminates.
    fn transitive_writes(facts: &[BodyFacts]) -> Vec<BTreeSet<String>> {
        let mut reachable: Vec<BTreeSet<String>> =
            facts.iter().map(|entry| entry.writes.clone()).collect();
        loop {
            let mut grew = false;
            for idx in 0..facts.len() {
                let mut merged = reachable[idx].clone();
                for callee in &facts[idx].calls {
                    merged.extend(reachable[*callee].iter().cloned());
                }
                if merged.len() != reachable[idx].len() {
                    reachable[idx] = merged;
                    grew = true;
                }
            }
            if !grew {
                return reachable;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Roster 1 — the declared exemptions (ADR-0258 D6)
//
// Every reducer the census reports as UNGATED must appear here with a basis, and
// every row here must still be ungated: the comparison is exact in BOTH
// directions, never a count and never a floor. Paying the debt down is a
// conscious edit of this roster, and so is widening it.
// ---------------------------------------------------------------------------

const DELIBERATE_EXEMPTIONS: &[(&str, &str)] = &[
    // (i) acts on an already-open commitment, which PRV1-10 and ADR-0227 D5 keep
    // completable while a deletion is pending.
    (
        "submit_attack",
        "acts on an already-open battle commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "swap_active",
        "acts on an already-open battle commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "flee",
        "unwinds an already-open battle commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "use_battle_item",
        "acts on an already-open battle commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "submit_pvp_action",
        "acts on an already-open PvP commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "cancel_trade",
        "unwinds an already-open trade commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "confirm_trade",
        "closes an already-open trade commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "cancel_challenge",
        "unwinds an already-open challenge; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "decline_challenge",
        "unwinds an already-open challenge; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    // (ii) the decline arm runs before the stamp-aware accept gate by design.
    (
        "respond_trade",
        "the decline arm unwinds the offer BEFORE the stamp-aware accept gate (ADR-0237)",
    ),
    // (iii) operator-only surface, unreachable by a player caller.
    (
        "sync_content",
        "operator-only behind the module-owner identity guard; no player caller exists",
    ),
    // (iv) KNOWN GAP — spec para 4.7 names these as gate targets and no slice has
    // gated them yet. Debt with a registered drain (one reject test per reducer),
    // not a decision that they stay ungated.
    (
        "join_game",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "evolve",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "care",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "train",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "essence_train",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "consume_crystalized_essence",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "attempt_recruit",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "set_nickname",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "set_party_slot",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "enqueue_move",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "set_move",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "clear_queue",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "dismiss_dialogue",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "ack_evolution_notices",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
];

// ---------------------------------------------------------------------------
// Roster 2 — the structural facts of the REAL crate (ADR-0258 D2, D5)
//
// The corpus is lib.rs plus every bare `mod x;` it declares, in declaration
// order; the two structural exemption sets are pinned EXACTLY so a new free ride
// is a conscious edit rather than a silent widening.
// ---------------------------------------------------------------------------

const EXPECTED_MODULES: &[&str] = &[
    "crate",
    "accounts",
    "battle",
    "content",
    "content_cache",
    "economy",
    "evolution",
    "guards",
    "inventory",
    "marshal",
    "monster_mgmt",
    "movement",
    "npc",
    "observability",
    "playtest",
    "privacy",
    "pvp",
    "raising",
    "ranking",
    "schema",
    "taming",
    "trading",
];

const EXPECTED_LIFECYCLE: &[&str] = &["init", "on_connect", "on_disconnect"];

const EXPECTED_SCHEDULED: &[&str] = &[
    "battle_challenge_reaper",
    "export_bundle_reaper",
    "guest_claim_reaper",
    "movement_tick",
    "mr_heartbeat",
    "playtest_reaper",
    "pvp_deadline_reaper",
    "trade_offer_reaper",
];

/// Every reducer that carries a depth-0 gate before its first write today. Pinned
/// as a SET in both directions: losing a gate is as much a regression as a new
/// ungated writer, and it is the half the exemption roster cannot see.
const EXPECTED_GATED: &[&str] = &[
    "accept_challenge",
    "advance_dialogue",
    "buy",
    "challenge_pvp",
    "complete_guest_claim",
    "grant_bait",
    "heal_party",
    "propose_trade",
    "request_data_export",
    "sell",
    "set_profile_name",
    "start_battle",
    "start_wild_battle",
    "talk",
];

/// Reducers that reach no classified write at all.
const EXPECTED_NO_WRITES: &[&str] = &["start_guest_claim"];

/// Vacuity floor for the manifest-derived classified set (24 tables at rb-45):
/// the set itself is derived in the test from `DATA_LIFECYCLE_MANIFEST`, so this
/// only refuses a manifest that shrank to nothing.
const CLASSIFIED_TABLE_FLOOR: usize = 24;

/// Reducer floor for the real corpus (54 at rb-45), so the per-reducer verdict
/// pin cannot be satisfied by an engine that finds almost none of them.
const REDUCER_FLOOR: usize = 54;

// ---------------------------------------------------------------------------
// Pure comparison helpers (test-side, never part of the engine)
// ---------------------------------------------------------------------------

/// Compare the census's ungated set against the declared roster in BOTH
/// directions and reject duplicate or basis-less roster rows. The failure
/// message prints each unrostered reducer's write set and helper chain, so a
/// widening is visible in review (ADR-0258 D6: the roster pins WHICH reducers
/// are ungated, not WHAT they write).
fn roster_mismatch(report: &census::Report, roster: &[(&str, &str)]) -> Result<(), String> {
    let rostered: BTreeSet<&str> = roster.iter().map(|&(name, _)| name).collect();
    let duplicates: BTreeSet<&str> = roster
        .iter()
        .map(|&(name, _)| name)
        .filter(|n| roster.iter().filter(|&&(m, _)| m == *n).count() > 1)
        .collect();
    let blank_basis: BTreeSet<&str> = roster
        .iter()
        .filter(|&&(_, basis)| basis.trim().is_empty())
        .map(|&(name, _)| name)
        .collect();
    let ungated = report.ungated();
    let unrostered: Vec<&str> = ungated
        .iter()
        .copied()
        .filter(|n| !rostered.contains(n))
        .collect();
    let stale: Vec<&str> = rostered
        .iter()
        .copied()
        .filter(|n| !ungated.contains(n))
        .collect();
    if duplicates.is_empty() && blank_basis.is_empty() && unrostered.is_empty() && stale.is_empty()
    {
        return Ok(());
    }
    let mut msg = String::from("the deletion-gate census does not match DELIBERATE_EXEMPTIONS");
    if !duplicates.is_empty() {
        msg.push_str(&format!("\n  duplicate roster rows: {duplicates:?}"));
    }
    if !blank_basis.is_empty() {
        msg.push_str(&format!(
            "\n  roster rows with an empty basis: {blank_basis:?}"
        ));
    }
    for name in &unrostered {
        msg.push_str(&format!(
            "\n  UNGATED and unrostered: {name} -- {}",
            describe_verdict(report, name)
        ));
    }
    for name in &stale {
        msg.push_str(&format!(
            "\n  rostered but no longer ungated: {name} -- {}",
            describe_verdict(report, name)
        ));
    }
    Err(msg)
}

/// One reducer's verdict rendered for the roster-failure message.
fn describe_verdict(report: &census::Report, name: &str) -> String {
    match report.verdicts.get(name) {
        Some(census::Verdict::Ungated {
            writes,
            first_write_stmt,
            gate_stmt,
            via,
        }) => {
            let writes: Vec<&str> = writes.iter().map(String::as_str).collect();
            let via: Vec<&str> = via.iter().map(String::as_str).collect();
            format!(
                "writes {writes:?}, first write-reaching statement {first_write_stmt}, \
                 gate statement {gate_stmt:?}, reached via {via:?}"
            )
        }
        Some(other) => format!("{other:?}"),
        None => String::from("no verdict at all"),
    }
}

fn classified_of(names: &[&'static str]) -> BTreeSet<&'static str> {
    names.iter().copied().collect()
}

fn census_of(sources: Vec<(String, String)>, classified: &[&'static str]) -> census::Report {
    let classified = classified_of(classified);
    census::census(&sources, &classified, game_core::STATE_TRANSITION_OWNERS)
        .unwrap_or_else(|e| panic!("the synthetic corpus must census cleanly, got {e:?}"))
}

fn census_one(module: &str, source: String, classified: &[&'static str]) -> census::Report {
    census_of(vec![(module.to_string(), source)], classified)
}

fn verdict_of<'a>(report: &'a census::Report, name: &str) -> &'a census::Verdict {
    report
        .verdicts
        .get(name)
        .unwrap_or_else(|| panic!("every reducer needs a verdict; none for {name}"))
}

fn assert_verdict(report: &census::Report, name: &str, want: census::Verdict) {
    assert_eq!(verdict_of(report, name), &want, "verdict for {name}");
}

/// Assert `name` is ungated with exactly `writes` and `gate_stmt`, and hand back
/// its first write-reaching statement index for the caller to pin.
fn assert_ungated(
    report: &census::Report,
    name: &str,
    writes: &[&str],
    gate_stmt: Option<usize>,
) -> usize {
    match verdict_of(report, name) {
        census::Verdict::Ungated {
            writes: got,
            first_write_stmt,
            gate_stmt: got_gate,
            via: _,
        } => {
            let want: BTreeSet<String> = writes.iter().map(|w| (*w).to_string()).collect();
            assert_eq!(got, &want, "ungated write set for {name}");
            assert_eq!(*got_gate, gate_stmt, "recorded gate statement for {name}");
            *first_write_stmt
        }
        other => panic!("{name} must be ungated, got {other:?}"),
    }
}

fn assert_via_non_empty(report: &census::Report, name: &str) {
    match verdict_of(report, name) {
        census::Verdict::Ungated { via, .. } => {
            assert!(
                !via.is_empty(),
                "the helper chain for {name} must be reported"
            );
        }
        other => panic!("{name} must be ungated, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Fixture builders — EVERY production-looking marker is spelled exactly once
// here, split across `concat!` pieces. Never inline one of these literals.
// ---------------------------------------------------------------------------

const CTX_DB: &str = concat!("ctx", ".db.");
const GUARDS_PATH: &str = concat!("crate::guards", "::");
const ACCOUNTS_PATH: &str = concat!("crate::accounts", "::");
const PENDING_PRED: &str = concat!("is_pending_", "deletion");
const REDUCER_CTX: &str = "ctx: &ReducerContext";
const OK_TAIL: &str = "Ok(())";

/// The qualified reducer-attribute head. Spelled ONCE here, split so it is never
/// contiguous in this file; the real-crate test counts reducers with this needle.
const REDUCER_ATTR_HEAD: &str = concat!("#[spacetimedb", "::reducer");

fn fixture_reducer_attr(arg: &str) -> String {
    if arg.is_empty() {
        format!("{REDUCER_ATTR_HEAD}]")
    } else {
        format!("{REDUCER_ATTR_HEAD}({arg})]")
    }
}

/// The bare spelling the engine must also accept.
fn fixture_reducer_attr_bare() -> String {
    String::from(concat!("#[re", "ducer]"))
}

fn fixture_table_attr(accessor: &str, extra: &str) -> String {
    let head = concat!("#[spacetimedb", "::table(", "accessor", " = ");
    if extra.is_empty() {
        format!("{head}{accessor})]")
    } else {
        format!("{head}{accessor}, {extra})]")
    }
}

fn fixture_sched_arg(reducer: &str) -> String {
    format!("{}{reducer})", concat!("schedul", "ed("))
}

fn fixture_table_item(accessor: &str, extra: &str, type_name: &str) -> String {
    format!(
        "{}\npub struct {type_name} {{\n    pub id: u64,\n}}\n\n",
        fixture_table_attr(accessor, extra)
    )
}

fn fixture_handle(accessor: &str) -> String {
    format!("{CTX_DB}{accessor}()")
}

fn fixture_method(receiver: &str, name: &str, args: &str) -> String {
    format!("{receiver}.{name}({args})")
}

fn fixture_write_stmt(accessor: &str, verb: &str) -> String {
    format!(
        "{};",
        fixture_method(&fixture_handle(accessor), verb, "row")
    )
}

/// The same write spelled across TWO source lines: a statement-index engine sees
/// one statement, a line-offset engine sees two and misreports every later index.
fn fixture_write_stmt_wrapped(accessor: &str, verb: &str) -> String {
    format!("{}\n        .{verb}(row);", fixture_handle(accessor))
}

/// One call to a gate-named wrapper, under an arbitrary path `prefix` and with an
/// arbitrary `suffix` — only the fully-qualified `?;` spelling is a gate.
fn fixture_gate_call(prefix: &str, wrapper: &str, suffix: &str) -> String {
    format!("{prefix}{wrapper}(ctx, tag){suffix}")
}

fn fixture_gate_stmt(wrapper: &str) -> String {
    fixture_gate_call(GUARDS_PATH, wrapper, "?;")
}

fn fixture_discarded_gate() -> String {
    format!(
        "let _ = {}",
        fixture_gate_call(GUARDS_PATH, "require_not_deleting", ";")
    )
}

/// Gate shape (b): `prefix` is the qualifying path, an empty string for the bare
/// spelling inside the accounts module, or a negation for the non-gate shape.
fn fixture_pending_if(prefix: &str, body: &str) -> String {
    format!("if {prefix}{PENDING_PRED}(ctx, me) {{ {body} }}")
}

fn fixture_reducer(attr: &str, name: &str, extra_params: &str, body: &[String]) -> String {
    let mut out = String::from(attr);
    out.push('\n');
    out.push_str(&format!(
        "pub fn {name}({REDUCER_CTX}{extra_params}) -> Result<(), String> {{\n"
    ));
    for stmt in body {
        out.push_str("    ");
        out.push_str(stmt);
        out.push('\n');
    }
    out.push_str("}\n\n");
    out
}

fn fixture_helper_fn(name: &str, body: &[String]) -> String {
    let mut out = format!("pub(crate) fn {name}({REDUCER_CTX}) {{\n");
    for stmt in body {
        out.push_str("    ");
        out.push_str(stmt);
        out.push('\n');
    }
    out.push_str("}\n\n");
    out
}

const SYNTH_UNGATED: &str = "synth_ungated_writer";

/// THE mandated tooth's payload: one table and one reducer that writes it with
/// no gate anywhere in the body.
fn fixture_synthetic_ungated_module() -> String {
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr(""),
        SYNTH_UNGATED,
        "",
        &[
            fixture_write_stmt("monster", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src
}

// ---------------------------------------------------------------------------
// The gating tests
// ---------------------------------------------------------------------------

#[test]
fn rb45_synthetic_ungated_reducer_is_flagged() {
    let synthetic = fixture_synthetic_ungated_module();

    let alone = census_one("synth", synthetic.clone(), &["monster"]);
    let first_write = assert_ungated(&alone, SYNTH_UNGATED, &["monster"], None);
    assert_eq!(
        first_write, 0,
        "the unguarded insert is statement 0 of the body"
    );

    let classified = census::classified_tables();
    let owners = game_core::STATE_TRANSITION_OWNERS;

    let mut injected_sources = census::real_sources().expect("real_sources must read the crate");
    injected_sources.push((String::from("synth"), synthetic));
    let injected = census::census(&injected_sources, &classified, owners)
        .expect("the real corpus plus one synthetic module must census cleanly");
    let failure = roster_mismatch(&injected, DELIBERATE_EXEMPTIONS)
        .expect_err("an injected ungated writer must fail the roster comparison");
    assert!(
        failure.contains(SYNTH_UNGATED),
        "the roster failure must name the offending reducer, got: {failure}"
    );

    let real_sources = census::real_sources().expect("real_sources must read the crate");
    let real = census::census(&real_sources, &classified, owners)
        .expect("the real corpus must census cleanly");
    if let Err(msg) = roster_mismatch(&real, DELIBERATE_EXEMPTIONS) {
        panic!("{msg}");
    }
}

#[test]
fn rb45_gate_after_the_first_write_is_ungated() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_reducer(
        &attr,
        "late_gate",
        "",
        &[
            fixture_write_stmt_wrapped("monster", "insert"),
            fixture_gate_stmt("require_not_deleting"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "late_pending_gate",
        "",
        &[
            fixture_write_stmt("monster", "insert"),
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "return Err(e);"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "nested_write_before_gate",
        "",
        &[
            format!("if flag {{ {} }}", fixture_write_stmt("monster", "insert")),
            fixture_gate_stmt("require_not_deleting"),
            String::from(OK_TAIL),
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    let first_write = assert_ungated(&report, "late_gate", &["monster"], Some(1));
    assert_eq!(
        first_write, 0,
        "the write is statement 0 and the gate is statement 1"
    );
    let first_write = assert_ungated(&report, "late_pending_gate", &["monster"], Some(2));
    assert_eq!(
        first_write, 0,
        "gate shape (b) at statement 2 is still after the write"
    );
    let first_write = assert_ungated(&report, "nested_write_before_gate", &["monster"], Some(1));
    assert_eq!(
        first_write, 0,
        "a write nested inside statement 0 makes statement 0 the first write-reaching one"
    );
}

#[test]
fn rb45_conditional_nested_negated_or_discarded_gate_is_not_a_gate() {
    let gate = fixture_gate_stmt("require_not_deleting");
    let write = fixture_write_stmt("monster", "insert");
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");

    src.push_str(&fixture_reducer(
        &attr,
        "gate_under_a_condition",
        "",
        &[format!("if flag {{ {gate} }}"), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_inside_a_block",
        "",
        &[format!("{{ {gate} }}"), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_under_a_negation",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(&format!("!{ACCOUNTS_PATH}"), "return Err(e);"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_with_a_discarded_verdict",
        "",
        &[fixture_discarded_gate(), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_hidden_in_a_helper",
        "",
        &[String::from("helper_that_gates(ctx)?;"), write.clone()],
    ));
    src.push_str(&fixture_helper_fn("helper_that_gates", &[gate]));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_a_return",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "log_something();"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_the_question_mark",
        "",
        &[
            fixture_gate_call(GUARDS_PATH, "require_not_deleting", ";"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_with_an_ok_suffix",
        "",
        &[
            fixture_gate_call(GUARDS_PATH, "require_not_deleting", ".ok();"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_full_qualification",
        "",
        &[
            fixture_gate_call("guards::", "require_not_deleting", "?;"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "bare_gate_name",
        "",
        &[
            fixture_gate_call("", "require_not_deleting", "?;"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "bare_predicate_outside_accounts",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if("", "return Err(e);"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "return_not_last_in_then_branch",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(
                ACCOUNTS_PATH,
                "if other { return Err(e); } log_something();",
            ),
            write,
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    for name in [
        "gate_under_a_condition",
        "gate_inside_a_block",
        "gate_under_a_negation",
        "gate_with_a_discarded_verdict",
        "gate_hidden_in_a_helper",
        "gate_without_a_return",
        "gate_without_the_question_mark",
        "gate_with_an_ok_suffix",
        "gate_without_full_qualification",
        "bare_gate_name",
        "bare_predicate_outside_accounts",
        "return_not_last_in_then_branch",
    ] {
        assert_ungated(&report, name, &["monster"], None);
    }
}

#[test]
fn rb45_table_handle_alias_write_is_a_write() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("battle", "", "SynthBattle");
    src.push_str(&fixture_table_item("character", "", "SynthCharacter"));

    src.push_str(&fixture_reducer(
        &attr,
        "writes_through_a_handle_alias",
        "",
        &[
            format!("let battles = {};", fixture_handle("battle")),
            format!(
                "{};",
                fixture_method(&fixture_method("battles", "battle_id", ""), "update", "row")
            ),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "writes_through_an_index_alias",
        "",
        &[
            format!(
                "let h = {};",
                fixture_method(&fixture_handle("battle"), "battle_id", "")
            ),
            format!("{};", fixture_method("h", "delete", "1")),
        ],
    ));
    let found_row = fixture_method(
        &fixture_method(
            &fixture_method(&fixture_handle("character"), "entity_id", ""),
            "find",
            "1",
        ),
        "unwrap",
        "",
    );
    src.push_str(&fixture_reducer(
        &attr,
        "clears_a_field_of_a_found_row",
        "",
        &[
            format!("let row = {found_row};"),
            format!("{};", fixture_method("row.move_queue", "clear", "")),
        ],
    ));

    let report = census_one("synth", src, &["battle", "character"]);
    let first = assert_ungated(&report, "writes_through_a_handle_alias", &["battle"], None);
    assert_eq!(
        first, 1,
        "the alias binding is statement 0; the write is statement 1"
    );
    let first = assert_ungated(&report, "writes_through_an_index_alias", &["battle"], None);
    assert_eq!(
        first, 1,
        "the alias binding is statement 0; the write is statement 1"
    );
    assert_verdict(
        &report,
        "clears_a_field_of_a_found_row",
        census::Verdict::NoClassifiedWrites,
    );
}

#[test]
fn rb45_helper_delegated_write_is_a_write() {
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("player_wallet", "insert");

    let mut synth = fixture_table_item("player_wallet", "", "SynthWallet");
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_a_same_module_helper",
        "",
        &[String::from("pay(ctx);"), String::from(OK_TAIL)],
    ));
    synth.push_str(&fixture_helper_fn("pay", std::slice::from_ref(&write)));
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_two_hops",
        "",
        &[
            String::from("crate::economy::grant(ctx);"),
            String::from(OK_TAIL),
        ],
    ));
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_a_cycle",
        "",
        &[String::from("a(ctx);"), String::from(OK_TAIL)],
    ));
    synth.push_str(&fixture_helper_fn("a", &[String::from("b(ctx);")]));
    synth.push_str(&fixture_helper_fn(
        "b",
        &[
            String::from("a(ctx);"),
            fixture_write_stmt("player_wallet", "delete"),
        ],
    ));

    let mut economy = fixture_helper_fn("grant", &[String::from("inner(ctx);")]);
    economy.push_str(&fixture_helper_fn("inner", &[write]));

    let report = census_of(
        vec![
            (String::from("synth"), synth),
            (String::from("economy"), economy),
        ],
        &["player_wallet"],
    );
    for name in [
        "spends_through_a_same_module_helper",
        "spends_through_two_hops",
        "spends_through_a_cycle",
    ] {
        let first = assert_ungated(&report, name, &["player_wallet"], None);
        assert_eq!(first, 0, "the delegating call is statement 0 for {name}");
        assert_via_non_empty(&report, name);
    }
}

#[test]
fn rb45_owner_lifecycle_and_scheduled_are_exempt_with_precedence() {
    let owners = game_core::STATE_TRANSITION_OWNERS;
    assert!(
        owners.len() >= 2,
        "this fixture needs two distinct owner names"
    );
    let plain_owner = owners[0];
    let scheduled_owner = owners[owners.len() - 1];
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("monster", "insert");

    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_table_item(
        "tick_schedule",
        &fixture_sched_arg("tick"),
        "TickSchedule",
    ));
    src.push_str(&fixture_table_item(
        "owner_schedule",
        &fixture_sched_arg(scheduled_owner),
        "OwnerSchedule",
    ));

    let one_write = std::slice::from_ref(&write);
    src.push_str(&fixture_reducer(&attr, plain_owner, "", one_write));
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr("client_connected"),
        "whatever_name",
        "",
        one_write,
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "tick",
        ", _s: TickSchedule",
        one_write,
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "not_scheduled",
        ", _s: TickSchedule",
        one_write,
    ));
    src.push_str(&fixture_reducer(&attr, scheduled_owner, "", one_write));

    let report = census_one("synth", src, &["monster"]);
    assert_verdict(&report, plain_owner, census::Verdict::Owner);
    assert_verdict(&report, "whatever_name", census::Verdict::Lifecycle);
    assert_verdict(&report, "tick", census::Verdict::Scheduled);
    assert_ungated(&report, "not_scheduled", &["monster"], None);
    assert_verdict(&report, scheduled_owner, census::Verdict::Owner);
}

#[test]
fn rb45_not_owned_and_foreign_writes_are_not_classified() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_table_item("config", "", "SynthConfig"));
    src.push_str(&fixture_table_item("player_wallet", "", "SynthWallet"));

    src.push_str(&fixture_reducer(
        &attr,
        "writes_a_not_owned_table",
        "",
        &[
            fixture_write_stmt("config", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "writes_outside_the_classified_argument",
        "",
        &[
            fixture_write_stmt("player_wallet", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr_bare(),
        "writes_a_hash_map",
        "",
        &[
            String::from("let mut counts = HashMap::new();"),
            format!("{};", fixture_method("counts", "insert", "key, value")),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "clears_a_vec",
        "",
        &[
            String::from("let mut seen = Vec::new();"),
            format!("{};", fixture_method("seen", "clear", "")),
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    for name in [
        "writes_a_not_owned_table",
        "writes_outside_the_classified_argument",
        "writes_a_hash_map",
        "clears_a_vec",
    ] {
        assert_verdict(&report, name, census::Verdict::NoClassifiedWrites);
    }
}

#[test]
fn rb45_both_gate_shapes_and_every_write_verb_are_recognised() {
    let frozen: BTreeSet<&str> = [
        "insert",
        "try_insert",
        "update",
        "delete",
        "clear",
        "insert_or_update",
        "try_insert_or_update",
    ]
    .into_iter()
    .collect();
    let declared: BTreeSet<&str> = census::WRITE_VERBS.iter().copied().collect();
    assert_eq!(
        declared, frozen,
        "the write-verb roster is frozen by ADR-0258 D3"
    );

    let wrappers = [
        "require_not_deleting",
        "require_subject_not_deleting",
        "require_commitment_predates_deletion",
    ];
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("monster", "insert");
    let mut src = fixture_table_item("monster", "", "SynthMonster");

    for wrapper in wrappers {
        src.push_str(&fixture_reducer(
            &attr,
            &format!("gated_by_{wrapper}"),
            "",
            &[fixture_gate_stmt(wrapper), write.clone()],
        ));
    }
    src.push_str(&fixture_reducer(
        &attr,
        "gated_by_the_pending_predicate",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "return Err(e);"),
            write.clone(),
        ],
    ));
    for &verb in census::WRITE_VERBS {
        src.push_str(&fixture_reducer(
            &attr,
            &format!("ungated_by_{verb}"),
            "",
            &[fixture_write_stmt("monster", verb)],
        ));
    }

    let report = census_one("synth", src, &["monster"]);
    for wrapper in wrappers {
        assert_verdict(
            &report,
            &format!("gated_by_{wrapper}"),
            census::Verdict::Gated {
                gate_stmt: 0,
                first_write_stmt: 1,
            },
        );
    }
    assert_verdict(
        &report,
        "gated_by_the_pending_predicate",
        census::Verdict::Gated {
            gate_stmt: 1,
            first_write_stmt: 2,
        },
    );
    for &verb in census::WRITE_VERBS {
        assert_ungated(&report, &format!("ungated_by_{verb}"), &["monster"], None);
    }

    let mut accounts_src = fixture_table_item("monster", "", "SynthMonster");
    accounts_src.push_str(&fixture_reducer(
        &attr,
        "gated_by_the_bare_predicate",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if("", "return Err(e);"),
            write,
        ],
    ));
    let accounts_report = census_one("accounts", accounts_src, &["monster"]);
    assert_verdict(
        &accounts_report,
        "gated_by_the_bare_predicate",
        census::Verdict::Gated {
            gate_stmt: 1,
            first_write_stmt: 2,
        },
    );
}

/// One refused shape: the module it lives in, its source, and a keyword the
/// engine's `what` must name it by (compared case-insensitively). The keyword is
/// part of the contract — a hard error that cannot say WHAT it refused is not
/// actionable.
struct RefusedShape {
    label: &'static str,
    module: &'static str,
    source: String,
    keyword: &'static str,
}

fn refused_shapes() -> Vec<RefusedShape> {
    let attr = fixture_reducer_attr("");
    let mut fn_pointer = fixture_helper_fn("helper", &[]);
    fn_pointer.push_str(&fixture_reducer(
        &attr,
        "binds_a_fn_pointer",
        "",
        &[
            String::from("let f = crate::synth::helper;"),
            String::from("let g = helper;"),
            String::from(OK_TAIL),
        ],
    ));

    vec![
        RefusedShape {
            label: "an item-position macro invocation",
            module: "synth",
            source: String::from("synth_macro! { }\n"),
            keyword: "macro",
        },
        RefusedShape {
            label: "a crate-local macro definition",
            module: "synth",
            source: String::from(concat!("macro_", "rules! synth { () => {} }\n")),
            keyword: "macro",
        },
        RefusedShape {
            label: "a nested mod inside a scanned module",
            module: "synth",
            source: String::from("mod inner;\n"),
            keyword: "mod",
        },
        RefusedShape {
            label: "an inline nested mod inside a scanned module",
            module: "synth",
            source: String::from("mod inline_inner {}\n"),
            keyword: "mod",
        },
        RefusedShape {
            label: "a crate-root mod under an inverted cfg",
            module: "crate",
            source: String::from(concat!("#[cf", "g(not(test))]\nmod hidden;\n")),
            keyword: "cfg",
        },
        RefusedShape {
            label: "a crate-root mod carrying only a path attribute",
            module: "crate",
            source: String::from(concat!("#[pa", "th = \"hidden.rs\"]\nmod hidden_path;\n")),
            keyword: "mod",
        },
        RefusedShape {
            label: "an import rename",
            module: "synth",
            source: String::from("use crate::schema::monster as m;\n"),
            keyword: "use as",
        },
        RefusedShape {
            label: "a fn-pointer let binding of a crate fn",
            module: "synth",
            source: fn_pointer,
            keyword: "pointer",
        },
        RefusedShape {
            label: "an impl-block fn that takes a reducer context",
            module: "synth",
            source: format!(
                "{}SynthThing {{\n    pub fn run({REDUCER_CTX}) {{}}\n}}\n",
                concat!("imp", "l ")
            ),
            keyword: "impl",
        },
        RefusedShape {
            label: "a helper returning a table handle",
            module: "synth",
            source: format!(
                "pub(crate) fn handle_of({REDUCER_CTX}) -> {} {{\n    lookup(ctx)\n}}\n",
                concat!("Table", "Handle")
            ),
            keyword: "handle",
        },
        RefusedShape {
            label: "a UFCS write spelling",
            module: "synth",
            source: fixture_reducer(
                &attr,
                "writes_by_ufcs",
                "",
                &[
                    format!("{}delete(&h, row);", concat!("Table", "::")),
                    String::from(OK_TAIL),
                ],
            ),
            keyword: "ufcs",
        },
        RefusedShape {
            label: "a procedure item",
            module: "synth",
            source: fixture_reducer(
                concat!("#[proce", "dure]"),
                "a_procedure",
                "",
                &[String::from(OK_TAIL)],
            ),
            keyword: "procedure",
        },
        RefusedShape {
            label: "a gate-named fn defined outside the guards module",
            module: "synth",
            source: format!(
                "pub(crate) fn require_not_deleting({REDUCER_CTX}, tag: &str) -> Result<(), \
                 String> {{\n    {OK_TAIL}\n}}\n"
            ),
            keyword: "shadow",
        },
    ]
}

fn accepted_shapes() -> Vec<(&'static str, &'static str, String)> {
    let cfg_test = concat!("#[cf", "g(test)]");
    let path_attr = concat!("#[pa", "th = \"synth_tests.rs\"]");
    vec![
        (
            "a test-only mod at the crate root",
            "crate",
            format!("{cfg_test}\nmod synth_tests;\n"),
        ),
        (
            "a test-only path mod at the crate root, the rb-77 wiring form",
            "crate",
            format!("{cfg_test}\n{path_attr}\nmod synth_tests;\n"),
        ),
        (
            "a test-only path mod inside a scanned module",
            "synth",
            format!("{cfg_test}\n{path_attr}\nmod synth_tests;\n"),
        ),
        (
            "an inline test-only mod inside a scanned module",
            "synth",
            format!("{cfg_test}\nmod tests {{}}\n"),
        ),
        (
            "a helper returning an encounter table",
            "synth",
            format!("pub(crate) fn table_of({REDUCER_CTX}) -> EncounterTable {{\n    load()\n}}\n"),
        ),
    ]
}

#[test]
fn rb45_unsupported_shapes_are_hard_errors() {
    let owners = game_core::STATE_TRANSITION_OWNERS;
    let classified = classified_of(&["monster"]);

    let rows = refused_shapes();
    assert_eq!(
        rows.len(),
        13,
        "every refused shape in ADR-0258 D2 needs a row"
    );
    let distinct: BTreeSet<String> = rows
        .iter()
        .map(|row| {
            let sources = vec![(String::from(row.module), row.source.clone())];
            match census::census(&sources, &classified, owners) {
                Err(census::CensusError::UnsupportedShape { module, what }) => {
                    assert_eq!(module, row.module, "module reported for {}", row.label);
                    assert!(
                        what.to_lowercase().contains(row.keyword),
                        "the refusal for {} must name it with the keyword {}, got: {what}",
                        row.label,
                        row.keyword
                    );
                    what
                }
                other => {
                    panic!(
                        "{} must be refused as an unsupported shape, got {other:?}",
                        row.label
                    )
                }
            }
        })
        .collect();
    assert_eq!(
        distinct.len(),
        rows.len(),
        "each refused shape needs its OWN message; one catch-all cannot serve them all"
    );

    let broken = vec![(String::from("synth"), String::from("pub fn ( {"))];
    assert!(
        matches!(
            census::census(&broken, &classified, owners),
            Err(census::CensusError::Parse { .. })
        ),
        "unparseable source must be a parse error, never an empty census"
    );

    let twin = fixture_reducer(
        &fixture_reducer_attr(""),
        "twin",
        "",
        &[String::from(OK_TAIL)],
    );
    let duplicated = vec![
        (String::from("synth"), twin.clone()),
        (String::from("economy"), twin),
    ];
    assert!(
        matches!(
            census::census(&duplicated, &classified, owners),
            Err(census::CensusError::DuplicateReducer { .. })
        ),
        "one reducer name may carry only one verdict"
    );

    let accepted = accepted_shapes();
    assert_eq!(
        accepted.len(),
        5,
        "the accepted shapes keep the refusals from over-reaching"
    );
    for (label, module, source) in accepted {
        let sources = vec![(String::from(module), source)];
        census::census(&sources, &classified, owners)
            .unwrap_or_else(|e| panic!("{label} must be accepted, got {e:?}"));
    }
}

#[test]
fn rb45_real_crate_matches_the_rosters() {
    let derived: BTreeSet<&str> = crate::schema::DATA_LIFECYCLE_MANIFEST
        .iter()
        .filter(|entry| !matches!(entry.policy, crate::schema::DeletionPolicy::NotOwned))
        .map(|entry| entry.table)
        .collect();
    assert!(
        derived.len() >= CLASSIFIED_TABLE_FLOOR,
        "the manifest classifies {} tables, below the rb-45 floor",
        derived.len()
    );
    let classified = census::classified_tables();
    assert_eq!(
        classified, derived,
        "the classified set IS the manifest minus NotOwned"
    );
    for table in ["monster", "battle", "pvp_deadline_schedule"] {
        assert!(classified.contains(table), "{table} is manifest-classified");
    }
    assert!(
        !classified.contains("config"),
        "a not-owned table is out of scope"
    );

    let owners = game_core::STATE_TRANSITION_OWNERS;
    let sources = census::real_sources().expect("real_sources must read the crate");
    let report =
        census::census(&sources, &classified, owners).expect("the real corpus must census cleanly");

    let want_n: usize = sources
        .iter()
        .map(|(_, source)| {
            source
                .lines()
                .filter(|line| line.trim_start().starts_with(REDUCER_ATTR_HEAD))
                .count()
        })
        .sum();
    assert!(
        want_n >= REDUCER_FLOOR,
        "the corpus carries {want_n} reducer attributes, below the rb-45 floor"
    );
    assert_eq!(
        report.verdicts.len(),
        want_n,
        "every reducer attribute in the corpus gets exactly one verdict"
    );

    if let Err(msg) = roster_mismatch(&report, DELIBERATE_EXEMPTIONS) {
        panic!("{msg}");
    }

    let lifecycle: BTreeSet<&str> = EXPECTED_LIFECYCLE.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Lifecycle)),
        lifecycle,
        "the lifecycle exemption set is pinned exactly"
    );

    let scheduled: BTreeSet<&str> = EXPECTED_SCHEDULED.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Scheduled)),
        scheduled,
        "the scheduled exemption set is pinned exactly"
    );

    let owner_set: BTreeSet<&str> = owners.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Owner)),
        owner_set,
        "every owner is a real reducer and nothing else is exempt as one"
    );

    let gated: BTreeSet<&str> = EXPECTED_GATED.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Gated { .. })),
        gated,
        "the gated set is pinned exactly, so losing a gate fails CI too"
    );

    let no_writes: BTreeSet<&str> = EXPECTED_NO_WRITES.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::NoClassifiedWrites)),
        no_writes,
        "only these reducers reach no classified write at all"
    );

    assert_eq!(
        report.modules.first().map(String::as_str),
        Some("crate"),
        "lib.rs is the first corpus entry"
    );
    let modules: Vec<&str> = report.modules.iter().map(String::as_str).collect();
    assert_eq!(
        modules,
        EXPECTED_MODULES.to_vec(),
        "the corpus is lib.rs plus its bare mods"
    );

    for name in ["grant_bait", "start_wild_battle"] {
        assert!(
            matches!(verdict_of(&report, name), census::Verdict::Gated { .. }),
            "{name} is gated today and is scanned even though its cfg hides it"
        );
    }

    for &(name, _basis) in DELIBERATE_EXEMPTIONS {
        assert!(
            report.verdicts.contains_key(name),
            "roster row {name} names a reducer that no longer exists"
        );
    }
}
