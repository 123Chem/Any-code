//! Finish readers after a confirmed process exit without retaining a session forever.

use std::time::Duration;
use tokio::task::JoinHandle;

pub(super) async fn after_exit(
    mut stdout: JoinHandle<()>,
    mut stderr: JoinHandle<()>,
    grace: Duration,
) -> Result<(), &'static str> {
    match tokio::time::timeout(grace, async {
        tokio::join!(&mut stdout, &mut stderr)
    }).await {
        Ok((Ok(()), Ok(()))) => Ok(()),
        Ok(_) => Err("Claude output reader failed; the original session history was preserved"),
        Err(_) => {
            stdout.abort();
            stderr.abort();
            // Release reader-owned leases before announcing that this run ended.
            // timeout may already have consumed one completed JoinHandle.
            if !stdout.is_finished() { let _ = stdout.await; }
            if !stderr.is_finished() { let _ = stderr.await; }
            Err("Claude process exited but output did not close; the original session history was preserved")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};

    #[tokio::test]
    async fn buffered_final_output_is_drained_before_completion() {
        let lines = Arc::new(AtomicUsize::new(0));
        let output = lines.clone();
        let stdout = tokio::spawn(async move {
            for _ in 0..64 {
                tokio::task::yield_now().await;
                output.fetch_add(1, Ordering::SeqCst);
            }
        });
        let stderr = tokio::spawn(async {});
        assert!(after_exit(stdout, stderr, Duration::from_secs(1)).await.is_ok());
        assert_eq!(lines.load(Ordering::SeqCst), 64);
    }

    #[tokio::test]
    async fn open_pipe_after_exit_does_not_pin_the_session_lease() {
        struct Lease(Arc<AtomicBool>);
        impl Drop for Lease {
            fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); }
        }
        let released = Arc::new(AtomicBool::new(false));
        let lease = Lease(released.clone());
        let stdout = tokio::spawn(async move {
            let _lease = lease;
            std::future::pending::<()>().await;
        });
        let stderr = tokio::spawn(async {});
        let result = after_exit(stdout, stderr, Duration::from_millis(20)).await;
        assert!(result.unwrap_err().contains("process exited"));
        assert!(released.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn reader_panic_is_an_explicit_failure_instead_of_a_successful_turn() {
        let stdout = tokio::spawn(async { panic!("offline reader fixture"); });
        let stderr = tokio::spawn(async {});
        assert!(after_exit(stdout, stderr, Duration::from_secs(1)).await.is_err());
    }
}
