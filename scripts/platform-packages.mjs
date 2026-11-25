/** Platform filenames and marketplace fields. Each native package carries its own service and media runtime. */
export const PLATFORM_TARGETS = [
    { id: 'macos-arm64', platform: 'macos', arch: 'arm64', suffix: 'macos', field: 'packageUrlMacos' },
    { id: 'macos-x64', platform: 'macos', arch: 'x64', suffix: 'macos-intel', field: 'packageUrlMacosIntel' },
    { id: 'windows-x64', platform: 'windows', arch: 'x64', suffix: 'windows', field: 'packageUrlWindows' },
    { id: 'windows-arm64', platform: 'windows', arch: 'arm64', suffix: 'windows-arm', field: 'packageUrlWindowsArm' },
    { id: 'linux-x64', platform: 'linux', arch: 'x64', suffix: 'linux', field: 'packageUrlLinux' },
    { id: 'linux-arm64', platform: 'linux', arch: 'arm64', suffix: 'linux-arm', field: 'packageUrlLinuxArm' },
];

export function platformPackageName(packid, version, suffix) {
    return `${packid}-${version}-${suffix}.oplg`;
}

export function combinedPackageName(packid, version) {
    return `${packid}-${version}.oplg`;
}

/** 给定发布模式，返回本次应该出现的全部 .oplg 文件名。 */
export function expectedPackageNames(packid, version, platformPackages) {
    return platformPackages
        ? PLATFORM_TARGETS.map((target) => platformPackageName(packid, version, target.suffix))
        : [combinedPackageName(packid, version)];
}
