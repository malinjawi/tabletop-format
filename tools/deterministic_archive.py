"""Small reproducible-ZIP helper shared by Forge's Python exporters."""
from pathlib import Path
import zipfile


FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def write_deterministic_zip(output, entries):
    """Write sorted (archive_name, bytes-or-path) entries with fixed metadata.

    Compression is reproducible within the digest-pinned release image. The
    release receipt remains the final byte authority, and Forge refuses a
    future rebuild whose hash differs.
    """
    normalized = sorted(entries, key=lambda entry: entry[0])
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9) as archive:
        for name, source in normalized:
            clean = str(name).replace("\\", "/").lstrip("/")
            if not clean or any(part in ("", ".", "..") for part in clean.split("/")):
                raise ValueError(f"unsafe ZIP entry: {name}")
            data = source.read_bytes() if isinstance(source, Path) else bytes(source)
            info = zipfile.ZipInfo(clean, date_time=FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.flag_bits |= 0x800
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED,
                             compresslevel=9)


def write_directory_zip(output, root, prefix=""):
    root = Path(root)
    entries = [
        ((Path(prefix) / path.relative_to(root)).as_posix(), path)
        for path in root.rglob("*") if path.is_file()
    ]
    write_deterministic_zip(output, entries)
