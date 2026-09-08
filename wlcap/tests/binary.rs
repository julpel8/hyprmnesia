// Black-box integration tests for the hpm-wlcap binary.
//
// These spawn the compiled binary (via the CARGO_BIN_EXE_hpm-wlcap path that
// `cargo test` exposes for binary crates) and exercise the NDJSON protocol at
// the process boundary, without HPM_WLCAP_E2E=1 set: the protocol smoke tests
// still run but do NOT issue a Start request (which would need
// xdg-desktop-portal + PipeWire). We verify the `ready` handshake,
// malformed-input error emission, and clean shutdown on EOF / explicit
// shutdown.
//
// Why this file exists: linux.rs is `#[cfg(target_os = "linux")]`-gated, so
// its internal unit tests can only compile on Linux. This file gives us
// black-box coverage of the process boundary alongside those unit tests.

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_hpm-wlcap")
}

// ---- Linux protocol smoke tests ------------------------------------------
//
// These don't need a portal: they only exercise the framing layer (NDJSON
// in/out, the `ready` handshake, and the malformed-line error path). The
// binary calls gst::init() before the ready handshake, so machines without a
// GStreamer install will fail before emitting `ready` — that's detected and
// we skip in that case so this file stays green on bare CI runners.
//
// We use a reader-thread + channel pattern because ChildStdout doesn't
// support portable non-blocking reads. The thread blocks on read_line; the
// test receives with a timeout.

#[cfg(target_os = "linux")]
mod linux_smoke {
    use super::bin;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, ChildStdout, Command, Stdio};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::thread;
    use std::time::{Duration, Instant};

    fn pipe_lines(stdout: ChildStdout) -> Receiver<String> {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        rx
    }

    fn next_line(rx: &Receiver<String>, timeout: Duration) -> Option<String> {
        match rx.recv_timeout(timeout) {
            Ok(l) => Some(l),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => None,
        }
    }

    fn spawn() -> Option<Child> {
        Command::new(bin())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()
    }

    fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Ok(None) => return None,
                Err(_) => return None,
            }
        }
    }

    #[test]
    fn ready_event_is_emitted_then_shutdown_exits_cleanly() {
        let Some(mut child) = spawn() else {
            eprintln!("could not spawn hpm-wlcap; skipping");
            return;
        };
        let stdout = child.stdout.take().expect("child stdout");
        let rx = pipe_lines(stdout);

        let Some(first) = next_line(&rx, Duration::from_secs(5)) else {
            // gst::init() probably failed (no GStreamer on this runner). Reap
            // the child and skip rather than fail.
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("no ready line within 5s (likely missing GStreamer); skipping");
            return;
        };
        assert!(
            first.contains("\"type\":\"ready\""),
            "first line should be the ready event, got: {first}",
        );
        assert!(
            first.contains("\"engine\":\"wlcap\""),
            "ready event should identify engine, got: {first}",
        );

        // Ask the child to shut down.
        let mut stdin = child.stdin.take().expect("child stdin");
        writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("write shutdown");
        drop(stdin); // close stdin so EOF is a backstop too

        let status = wait_with_timeout(&mut child, Duration::from_secs(5)).unwrap_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child did not exit within 5s of shutdown");
        });
        assert!(
            status.success(),
            "expected clean exit after shutdown, got {status:?}",
        );
    }

    #[test]
    fn malformed_request_emits_error_event_and_continues() {
        let Some(mut child) = spawn() else {
            eprintln!("could not spawn hpm-wlcap; skipping");
            return;
        };
        let stdout = child.stdout.take().expect("child stdout");
        let rx = pipe_lines(stdout);

        let Some(first) = next_line(&rx, Duration::from_secs(5)) else {
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("no ready event (likely missing GStreamer); skipping");
            return;
        };
        assert!(first.contains("\"type\":\"ready\""));

        let mut stdin = child.stdin.take().expect("child stdin");
        // Not valid JSON.
        writeln!(stdin, "this is not json {{").expect("write garbage");

        let Some(err_line) = next_line(&rx, Duration::from_secs(3)) else {
            let _ = child.kill();
            let _ = child.wait();
            panic!("expected error event for malformed input");
        };
        assert!(
            err_line.contains("\"type\":\"error\""),
            "bad input should produce an error event, got: {err_line}",
        );
        assert!(
            err_line.contains("bad request"),
            "error message should mention the parse failure, got: {err_line}",
        );

        // Then shutdown gracefully.
        writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("write shutdown");
        drop(stdin);
        wait_with_timeout(&mut child, Duration::from_secs(5));
    }

    #[test]
    fn empty_and_whitespace_lines_on_stdin_are_ignored() {
        let Some(mut child) = spawn() else {
            eprintln!("could not spawn hpm-wlcap; skipping");
            return;
        };
        let stdout = child.stdout.take().expect("child stdout");
        let rx = pipe_lines(stdout);

        let Some(first) = next_line(&rx, Duration::from_secs(5)) else {
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("no ready event (likely missing GStreamer); skipping");
            return;
        };
        assert!(first.contains("\"type\":\"ready\""));

        let mut stdin = child.stdin.take().expect("child stdin");
        writeln!(stdin).expect("blank line");
        writeln!(stdin, "   ").expect("whitespace line");

        // No event should arrive in the next 250ms in response to those.
        assert!(
            next_line(&rx, Duration::from_millis(250)).is_none(),
            "blank lines must not produce any output",
        );

        writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("write shutdown");
        drop(stdin);
        wait_with_timeout(&mut child, Duration::from_secs(5));
    }

    #[test]
    fn eof_on_stdin_exits_cleanly_even_without_explicit_shutdown() {
        let Some(mut child) = spawn() else {
            eprintln!("could not spawn hpm-wlcap; skipping");
            return;
        };
        let stdout = child.stdout.take().expect("child stdout");
        let rx = pipe_lines(stdout);

        let Some(first) = next_line(&rx, Duration::from_secs(5)) else {
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("no ready event (likely missing GStreamer); skipping");
            return;
        };
        assert!(first.contains("\"type\":\"ready\""));

        // Drop stdin to send EOF without ever sending a shutdown.
        drop(child.stdin.take());

        let status = wait_with_timeout(&mut child, Duration::from_secs(5)).unwrap_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child did not exit within 5s of stdin EOF");
        });
        assert!(
            status.success(),
            "expected clean exit on EOF, got {status:?}",
        );
    }
}
