import { fileTypeFromBuffer } from "file-type";
import type { CoreDeps } from "@beamhop/sdk";
import { BlossomError } from "./http";
import { isMimeAllowed, isSvgText, normalizeMime, typeOfUnrecognized } from "./mime";
import type { BlobRepo } from "./repo";

/** What may be stored: refused (blocklisted / blocked) hashes and the type allowlist, with type detection. */
export class TypePolicy {
  constructor(
    private readonly deps: CoreDeps,
    private readonly repo: BlobRepo,
  ) {}

  async assertNotRefused(sha256: string): Promise<void> {
    if (await this.isRefused(sha256)) throw new BlossomError(403, "blob is blocked on this server");
  }

  /**
   * Blocklisted, moderated to "blocked" (the row's status), or bytes whose stripped form is one of those (a blocked
   * stripped upload can't come back byte-identical, e.g. through a mirror, which never strips).
   */
  async isRefused(sha256: string | string[]): Promise<boolean> {
    return this.repo.refused(Array.isArray(sha256) ? sha256 : [sha256]);
  }

  assertAllowedType(type: string) {
    if (!isMimeAllowed(type, this.deps.settings.get().blossom.allowedMimeTypes)) throw new BlossomError(415, `type ${type} is not allowed`);
  }

  /** Type from magic bytes; an SVG with an XML prolog (which file-type calls application/xml) is image/svg+xml. */
  async sniffType(data: Uint8Array): Promise<string | undefined> {
    let mime: string | undefined;
    try {
      mime = (await fileTypeFromBuffer(data))?.mime;
    } catch {
      return undefined;
    }
    return mime === "application/xml" && isSvgText(data) ? "image/svg+xml" : mime;
  }

  /** Sniffed type, else (unrecognised bytes) a declared text type only when the bytes are text. */
  async detectType(data: Uint8Array, declared?: string | null): Promise<string> {
    return (await this.sniffType(data)) ?? typeOfUnrecognized(data, normalizeMime(declared));
  }
}
