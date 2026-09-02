//! Small helpers shared by the NDJSON-over-stdio native workers (hpm-asr,
//! hpm-embed, hpm-sck, hpm-wlcap).

use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Shared stdout handle for the NDJSON worker protocol.
pub type SharedOut = Arc<Mutex<io::Stdout>>;

/// Write one NDJSON record to the shared stdout and flush. Errors (a poisoned
/// lock or a broken pipe) are ignored so the worker keeps running.
pub fn emit(out: &SharedOut, value: serde_json::Value) {
    if let Ok(mut handle) = out.lock() {
        let _ = writeln!(*handle, "{value}");
        let _ = handle.flush();
    }
}

/// Milliseconds since the Unix epoch, saturating to 0 before 1970.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
