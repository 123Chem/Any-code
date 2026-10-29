//! Preserve a settings file's access restrictions before writing its copies.

use std::path::Path;

#[cfg(windows)]
#[derive(PartialEq, Eq)]
pub struct FileAccess(Vec<u8>);

#[cfg(not(windows))]
pub struct FileAccess(std::fs::Permissions);

#[cfg(windows)]
pub(super) fn windows_security_path(path: &Path) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;
    // Canonical Windows paths keep their verbatim prefix for long backup names.
    let absolute = std::fs::canonicalize(path)
        .map_err(|error| format!("Cannot resolve settings security path: {error}"))?;
    Ok(absolute.as_os_str().encode_wide().chain(Some(0)).collect())
}

impl FileAccess {
    #[cfg(windows)]
    pub fn capture(path: &Path) -> Result<Self, String> {
        let path = windows_security_path(path)?;
        let mut needed = 0u32;
        unsafe { GetFileSecurityW(path.as_ptr(), 4, std::ptr::null_mut(), 0, &mut needed) };
        if needed == 0 {
            return Err(format!("Cannot read original settings access protection: {}",
                               std::io::Error::last_os_error()));
        }
        let mut data = vec![0; needed as usize];
        if unsafe { GetFileSecurityW(path.as_ptr(), 4, data.as_mut_ptr().cast(), needed, &mut needed) } == 0 {
            return Err(format!("Cannot read original settings access protection: {}",
                               std::io::Error::last_os_error()));
        }
        Ok(Self(data))
    }

    #[cfg(windows)]
    pub fn apply(&self, path: &Path) -> Result<(), String> {
        let mut path = windows_security_path(path)?;
        let descriptor = self.0.as_ptr().cast();
        let (mut control, mut revision) = (0u16, 0u32);
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(format!("Cannot decode original settings access protection: {}",
                               std::io::Error::last_os_error()));
        }
        let protection = if control & 0x1000 != 0 { 0x8000_0000 } else { 0x2000_0000 };
        // Each API normalizes the other inheritance mode. Copies are siblings of
        // the original settings, so retain its mode along with its DACL rules.
        if control & 0x0400 != 0 {
            let (mut present, mut defaulted) = (0i32, 0i32);
            let mut dacl = std::ptr::null_mut();
            if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) } == 0 {
                return Err(format!("Cannot decode original settings access protection: {}",
                                   std::io::Error::last_os_error()));
            }
            let status = unsafe { SetNamedSecurityInfoW(path.as_mut_ptr(), 1, 4 | protection,
                std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null_mut()) };
            if status != 0 {
                return Err(format!("Cannot preserve original settings access protection: {}",
                                   std::io::Error::from_raw_os_error(status as i32)));
            }
        } else if unsafe { SetFileSecurityW(path.as_ptr(), 4 | protection, descriptor) } == 0 {
            return Err(format!("Cannot preserve original settings access protection: {}",
                               std::io::Error::last_os_error()));
        }
        Ok(())
    }

    #[cfg(all(test, windows))]
    pub fn diagnostic(&self) -> String {
        use sha2::{Digest, Sha256};
        let descriptor = self.0.as_ptr().cast();
        let (mut control, mut revision) = (0u16, 0u32);
        let (mut present, mut defaulted) = (0i32, 0i32);
        let mut dacl = std::ptr::null_mut();
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) } == 0 {
            return "DACL descriptor could not be inspected".into();
        }
        let mut sizes = [0u32; 3];
        let acl = if present == 0 { "absent".into() } else if dacl.is_null() { "null".into() }
            else if unsafe { GetAclInformation(dacl, sizes.as_mut_ptr().cast(), 12, 2) } != 0 {
                format!("ACE_count={}, used={}, free={}", sizes[0], sizes[1], sizes[2])
            } else { "unreadable".into() };
        format!("control={control:#06x}, present={present}, defaulted={defaulted}, {acl}, descriptor_sha256={:x}",
                Sha256::digest(&self.0))
    }

    #[cfg(not(windows))]
    pub fn capture(path: &Path) -> Result<Self, String> {
        std::fs::metadata(path).map(|meta| Self(meta.permissions()))
            .map_err(|error| format!("Cannot read original settings permissions: {error}"))
    }

    #[cfg(not(windows))]
    pub fn apply(&self, path: &Path) -> Result<(), String> {
        std::fs::set_permissions(path, self.0.clone())
            .map_err(|error| format!("Cannot preserve original settings permissions: {error}"))
    }
}

#[cfg(windows)]
#[link(name = "advapi32")]
extern "system" {
    fn GetFileSecurityW(path: *const u16, info: u32, descriptor: *mut std::ffi::c_void,
                        size: u32, needed: *mut u32) -> i32;
    fn GetSecurityDescriptorControl(descriptor: *const std::ffi::c_void,
                                    control: *mut u16, revision: *mut u32) -> i32;
    fn GetSecurityDescriptorDacl(descriptor: *const std::ffi::c_void, present: *mut i32,
                                 dacl: *mut *mut std::ffi::c_void, defaulted: *mut i32) -> i32;
    fn SetFileSecurityW(path: *const u16, info: u32, descriptor: *const std::ffi::c_void) -> i32;
    fn SetNamedSecurityInfoW(path: *mut u16, kind: i32, info: u32,
                             owner: *mut std::ffi::c_void, group: *mut std::ffi::c_void,
                             dacl: *mut std::ffi::c_void, sacl: *mut std::ffi::c_void) -> u32;
    #[cfg(test)]
    fn GetAclInformation(dacl: *const std::ffi::c_void, information: *mut std::ffi::c_void,
                         size: u32, class: i32) -> i32;
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::ffi::c_void;
    use std::fs;

    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl: *const u16, revision: u32,
            descriptor: *mut *mut c_void, size: *mut u32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" { fn LocalFree(memory: *mut c_void) -> *mut c_void; }

    fn paths(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let mut root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../analysis/verification")
            .join(format!("anycode-acl-{label}-{}", uuid::Uuid::new_v4()));
        for index in 0..4 { root = root.join(format!("long-{index}-{}", "x".repeat(55))); }
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.json");
        let copy = root.join("copy.json");
        fs::write(&source, b"{\"fixture\":true}").unwrap();
        fs::write(&copy, b"{\"fixture\":true}").unwrap();
        assert!(windows_security_path(&source).unwrap().len() > 260);
        (source, copy)
    }

    fn from_sddl(sddl: &str) -> FileAccess {
        let input: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        let mut size = 0u32;
        assert_ne!(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(input.as_ptr(), 1,
            &mut descriptor, &mut size) }, 0);
        let data = unsafe { std::slice::from_raw_parts(descriptor.cast::<u8>(), size as usize).to_vec() };
        unsafe { LocalFree(descriptor); }
        FileAccess(data)
    }

    fn control(access: &FileAccess) -> u16 { u16::from_le_bytes([access.0[2], access.0[3]]) }

    fn install_original(access: &FileAccess, path: &Path) {
        let path = windows_security_path(path).unwrap();
        let protection = if control(access) & 0x1000 != 0 { 0x8000_0000 } else { 0x2000_0000 };
        assert_ne!(unsafe { SetFileSecurityW(path.as_ptr(), 4 | protection, access.0.as_ptr().cast()) }, 0);
    }

    fn install_automatic(path: &Path) {
        let access = FileAccess::capture(path).unwrap();
        let mut path = windows_security_path(path).unwrap();
        let (mut present, mut defaulted) = (0i32, 0i32);
        let mut dacl = std::ptr::null_mut();
        assert_ne!(unsafe { GetSecurityDescriptorDacl(access.0.as_ptr().cast(), &mut present,
                                                      &mut dacl, &mut defaulted) }, 0);
        let protection = if control(&access) & 0x1000 != 0 { 0x8000_0000 } else { 0x2000_0000 };
        assert_eq!(unsafe { SetNamedSecurityInfoW(path.as_mut_ptr(), 1, 4 | protection,
            std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null_mut()) }, 0);
    }

    fn roundtrip(source: &Path, copy: &Path) {
        let original = FileAccess::capture(source).unwrap();
        original.apply(source).unwrap();
        original.apply(copy).unwrap();
        for path in [source, copy] {
            let actual = FileAccess::capture(path).unwrap();
            assert!(actual == original, "ACL changed: {} -> {}", original.diagnostic(), actual.diagnostic());
        }
    }

    #[test]
    fn legacy_inherited_dacl_keeps_all_aces_and_nonautomatic_state() {
        let (source, copy) = paths("legacy-inherited");
        let mut original = FileAccess::capture(&source).unwrap();
        original.0[3] &= !0x04;
        install_original(&original, &source);
        assert_eq!(control(&FileAccess::capture(&source).unwrap()) & 0x0400, 0);
        roundtrip(&source, &copy);
    }

    #[test]
    fn legacy_explicit_unprotected_dacl_keeps_denies_and_does_not_add_parent_grants() {
        let (source, copy) = paths("legacy-explicit");
        install_original(&from_sddl("D:(D;;FW;;;BG)(A;;FA;;;SY)(A;;FA;;;BA)"), &source);
        assert_eq!(control(&FileAccess::capture(&source).unwrap()) & 0x1400, 0);
        roundtrip(&source, &copy);
    }

    #[test]
    fn protected_deny_dacl_keeps_its_rules_and_protection() {
        let (source, copy) = paths("protected");
        install_original(&from_sddl("D:P(D;;FW;;;BG)(A;;FA;;;SY)(A;;FA;;;BA)"), &source);
        assert_eq!(control(&FileAccess::capture(&source).unwrap()) & 0x1400, 0x1000);
        roundtrip(&source, &copy);
    }

    #[test]
    fn automatic_inherited_dacl_keeps_its_rules_and_inheritance_state() {
        let (source, copy) = paths("auto-inherited");
        install_automatic(&source);
        assert_ne!(control(&FileAccess::capture(&source).unwrap()) & 0x0400, 0);
        roundtrip(&source, &copy);
    }

    #[test]
    fn automatic_explicit_dacl_keeps_its_denies_and_parent_rules() {
        let (source, copy) = paths("auto-explicit");
        install_original(&from_sddl("D:(D;;FW;;;BG)(A;;FA;;;SY)(A;;FA;;;BA)"), &source);
        install_automatic(&source);
        assert_eq!(control(&FileAccess::capture(&source).unwrap()) & 0x1400, 0x0400);
        roundtrip(&source, &copy);
    }

    #[test]
    fn automatic_protected_dacl_keeps_its_denies_and_protection() {
        let (source, copy) = paths("auto-protected");
        install_original(&from_sddl("D:P(D;;FW;;;BG)(A;;FA;;;SY)(A;;FA;;;BA)"), &source);
        install_automatic(&source);
        assert_eq!(control(&FileAccess::capture(&source).unwrap()) & 0x1400, 0x1400);
        roundtrip(&source, &copy);
    }
}
