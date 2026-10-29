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
        let (mut present, mut defaulted) = (0i32, 0i32);
        let mut dacl = std::ptr::null_mut();
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) } == 0 {
            return Err(format!("Cannot decode original settings access protection: {}",
                               std::io::Error::last_os_error()));
        }
        let protection = if control & 0x1000 != 0 { 0x8000_0000 } else { 0x2000_0000 };
        let error = unsafe { SetNamedSecurityInfoW(path.as_mut_ptr(), 1, 4 | protection,
                            std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null_mut()) };
        if error != 0 {
            return Err(format!("Cannot preserve original settings access protection: {}",
                               std::io::Error::from_raw_os_error(error as i32)));
        }
        Ok(())
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
    fn SetNamedSecurityInfoW(path: *mut u16, kind: i32, info: u32,
                             owner: *mut std::ffi::c_void, group: *mut std::ffi::c_void,
                             dacl: *mut std::ffi::c_void, sacl: *mut std::ffi::c_void) -> u32;
}
