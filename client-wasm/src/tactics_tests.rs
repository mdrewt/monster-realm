//! bt-11 host tests over the inner tactics fns of `lib.rs` (`super::*`): the wasm wrappers take
//! `JsValue`, which is not constructible natively, so the rules composition is proven here on the
//! host and its marshaling in `client/src/tactics/wasm.test.ts` against the built pkg.
