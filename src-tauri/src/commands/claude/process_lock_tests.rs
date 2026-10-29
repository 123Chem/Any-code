//! Real child-process lock contracts, using only GUID-named temporary fixtures.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SESSION: &str = "commands::claude::session_policy::tests::guard_contract_process";
const SETTINGS: &str = "commands::claude::settings_store::tests::settings_guard_contract_process";

struct ContractChild {
    child: Option<Child>,
    release: Option<PathBuf>,
}

impl ContractChild {
    fn start(entry: &str, root: &Path, id: &str, mode: &str) -> Self {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--ignored", "--exact", entry, "--nocapture", "--test-threads=1"])
            .env("CLAUDE_GUARD_CONTRACT_ROOT", root)
            .env("CLAUDE_GUARD_CONTRACT_ID", id)
            .env("CLAUDE_GUARD_CONTRACT_MODE", mode)
            .env("RUST_BACKTRACE", "0")
            .current_dir(root).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let release = (mode == "hold").then(|| root.join(if entry == SESSION {
            "release-anycode.txt"
        } else { "release-settings-anycode.txt" }));
        Self { child: Some(command.spawn().unwrap()), release }
    }

    fn ready(&mut self, path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !path.is_file() {
            assert!(self.child.as_mut().unwrap().try_wait().unwrap().is_none(), "holder exited before ready");
            assert!(Instant::now() < deadline, "holder readiness timed out");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn output(mut self) -> Output {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if self.child.as_mut().unwrap().try_wait().unwrap().is_some() {
                return self.child.take().unwrap().wait_with_output().unwrap();
            }
            assert!(Instant::now() < deadline, "contract child timed out");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn released(self) -> Output {
        fs::write(self.release.as_ref().unwrap(), b"release").unwrap();
        self.output()
    }
}

impl Drop for ContractChild {
    fn drop(&mut self) {
        // Assertion failures must release the holder; fixture evidence is retained.
        if let Some(path) = &self.release { let _ = fs::write(path, b"release"); }
        let Some(child) = self.child.as_mut() else { return; };
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => break,
            }
        }
        // This handle belongs only to the test process spawned above, never a CLI.
        if child.kill().is_ok() { let _ = child.wait(); }
    }
}

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("anycode-contract-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn successful(output: Output, marker: &str) {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("running 1 test") && stdout.contains(marker), "{stdout}");
}

#[test]
fn original_session_uuid_is_exclusive_between_independent_processes() {
    let root = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let mut holder = ContractChild::start(SESSION, root.as_path(), &id, "hold");
    holder.ready(&root.as_path().join("ready-anycode.txt"));
    successful(ContractChild::start(SESSION, root.as_path(), &id.to_uppercase(), "probe").output(), "CONTRACT_BUSY=");
    successful(holder.released(), "CONTRACT_ACQUIRED=");
    successful(ContractChild::start(SESSION, root.as_path(), &id, "probe").output(), "CONTRACT_ACQUIRED=");
}

#[test]
fn settings_writer_blocks_other_processes_and_preserves_original_bytes() {
    let root = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let path = root.as_path().join("settings.json");
    let before = b"\xef\xbb\xbf{\r\n\"env\":{\"FIXTURE\":\"keep\"},\"unknown\":true\r\n}\r\n";
    fs::write(&path, before).unwrap();
    let mut holder = ContractChild::start(SETTINGS, root.as_path(), &id, "hold");
    holder.ready(&root.as_path().join("ready-settings-anycode.txt"));
    successful(ContractChild::start(SETTINGS, root.as_path(), &id, "probe").output(), "CONTRACT_BUSY=settings");
    let blocked = ContractChild::start(SETTINGS, root.as_path(), &id, "update").output();
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stdout).contains("running 1 test"));
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("Claude settings are being saved by another client"));
    assert_eq!(fs::read(&path).unwrap(), before);
    successful(holder.released(), "CONTRACT_ACQUIRED=settings");
    successful(ContractChild::start(SETTINGS, root.as_path(), &id, "update").output(), "CONTRACT_UPDATED=settings");
    let saved = super::settings_store::read(&path).unwrap();
    assert_eq!(saved["env"]["FIXTURE"], "keep");
    assert_eq!(saved["env"]["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"], "60");
    assert_eq!(saved["unknown"], true);
}
