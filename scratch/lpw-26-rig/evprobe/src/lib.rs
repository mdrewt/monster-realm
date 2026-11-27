//! lpw-26 probe: what an event table does on the pinned host. One event table, one stored
//! table of the same columns, and reducers that write one row to either or nothing at all.
use spacetimedb::{ReducerContext, Table};

#[spacetimedb::table(accessor = step_event, public, event)]
pub struct StepEvent {
    pub entity_id: u64,
    pub x: i32,
    pub y: i32,
}

#[spacetimedb::table(accessor = pos, public)]
pub struct Pos {
    #[primary_key]
    pub entity_id: u64,
    pub x: i32,
    pub y: i32,
}

#[spacetimedb::reducer]
pub fn emit(ctx: &ReducerContext, entity_id: u64, x: i32, y: i32) {
    ctx.db.step_event().insert(StepEvent { entity_id, x, y });
}

#[spacetimedb::reducer]
pub fn store(ctx: &ReducerContext, entity_id: u64, x: i32, y: i32) {
    ctx.db.pos().entity_id().delete(entity_id);
    ctx.db.pos().insert(Pos { entity_id, x, y });
}

#[spacetimedb::reducer]
pub fn noop(_ctx: &ReducerContext) {}
