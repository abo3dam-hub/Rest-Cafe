// Rest&Cafe afterPack hook.
//
// The packaged app is Windows x64 only. electron-builder runs this hook
// after packing; there is no platform-specific work to do for the NSIS
// target (the win32-x64 better-sqlite3 prebuild is validated by the
// release-asset checks), so the hook intentionally does nothing.
module.exports = async function afterPack() {};
