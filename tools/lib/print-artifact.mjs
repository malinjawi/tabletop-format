// Changed print bytes get new URLs even for an unchanged game commit. Legacy
// names remain readable only through their existing publication evidence.
export const PRINT_EXPORT_VERSION = 3;
export const printArtifactName = suffix => `v${PRINT_EXPORT_VERSION}-print-${suffix}`;
export const isPrintArtifact = name => /^(?:v[1-9][0-9]*-)?print-(?:ready\.zip|(?:a4|letter|press-rgb|press-cmyk|calibration-a4|calibration-letter)\.pdf)$/.test(name);
