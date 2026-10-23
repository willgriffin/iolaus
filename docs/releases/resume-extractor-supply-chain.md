# Hardened extractor supply-chain disposition

Assessment date: 2026-10-22 America/Edmonton (scanner timestamp 2026-10-23T04:40:32Z). Read-only source/package/advisory analysis; no exploit or container testing.

## Exact evidence and conclusion

Artifact: `/input/extractor-hardened.tar`, Trivy artifact ID `sha256:85491399f31a98b06e4b015068c2ad12c6e04fba9021a1e8abb593d981219249`, from `/tmp/iolaus-resume-production/extractor-hardened-trivy.json`. This ID is the scanner artifact identifier, not asserted to be the registry manifest digest.

**Remaining results: 57 Debian matches (56 high, 1 critical), covering 12 unique CVEs; 15 Node high matches, covering 14 unique advisory IDs. This is not a zero-findings image.** Inventory contains 89 Debian and 968 Node package records. It confirms `pdfjs-dist@6.2.108`, `proxy-addr@2.0.8`, and `perl-base@5.36.0-7+deb12u4` (full Debian version in vulnerability record); no npm package, minizip binary package, systemd-homed package, or perl-modules package appears in this inventory. Absence from package inventory is not a complete filesystem attestation.

**No concrete remaining advisory path from an uploaded PDF to the vulnerable feature was established.** The one critical match is specifically non-applicable to Debian's zlib1g binary, per Debian's own build disposition. Other residuals have separate, explicit feature prerequisites below; they must remain visible in the receipt. This does not prove all malformed PDFs harmless or exclude unknown/parser/native-library issues. Full-site exposure is a separate assessment: the old `site-trivy.json` is not evidence for a final rebuilt site image.

## Debian families

| Family / installed version | Matches | Disposition for this extractor |
|---|---:|---|
| zlib1g `1:1.2.13.dfsg-1`, CVE-2023-45853 | 1 critical | **Source-package false positive for this binary.** Vulnerability is MiniZip ZIP creation, not zlib inflate used for PDF streams. Debian explicitly says bookworm does not build contrib/minizip from src:zlib and affected code is not provided by its binary packages. No separate minizip package appears in scan. Record this narrow exception; do not dismiss all zlib findings. [Debian](https://security-tracker.debian.org/tracker/CVE-2023-45853). |
| util-linux `2.38.1-5+deb12u3`: bsdutils, libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra | 48 high (6 CVEs × 8 packages) | **Unfixed in scanned bookworm closure; feature-not-reached by PDF flow.** CVE-2026-53613/76642/78409/78410 involve mount target/helper/subdirectory/bind operations; CVE-2026-78408 requires nsenter cgroup joining; CVE-2026-53615 requires probing crafted partition tables. Extractor invokes only a Node child, not mount/nsenter/block-device probing. These are not 48 independent PDF bugs. Preserve nonprivileged deployment; track base updates. [Partition advisory](https://security-tracker.debian.org/tracker/CVE-2026-53615). |
| gzip `1.12-1`, CVE-2026-41992 | 1 high | **Unfixed/deferred; vulnerable CLI feature not called.** Requires sequential crafted LZW/LZH decompression in one GNU gzip invocation. PDF Flate decoding does not imply execution of GNU gzip. [Debian](https://security-tracker.debian.org/tracker/CVE-2026-41992). |
| libacl1 `2.3.1-3`, CVE-2026-54369 | 1 high | **Unfixed/deferred; no privileged ACL caller in supported flow.** Requires attacker-controlled path components processed by privileged pathname ACL operations. Worker writes its own private temp files and runs non-root; ordinary chmod is not the vulnerable libacl API. [Debian](https://security-tracker.debian.org/tracker/CVE-2026-54369). |
| libsystemd0 / libudev1 `252.39-1~deb12u2`, CVE-2026-16742 | 2 high | **Affected source family, absent operating feature.** Issue is homed-managed local-user privilege escalation; package inventory has libraries, not systemd-homed, and PID 1 application is Node. Do not treat library presence as a running homed service. [Debian](https://security-tracker.debian.org/tracker/CVE-2026-16742). |
| libtinfo6 / ncurses-base / ncurses-bin `6.4-4`, CVE-2025-69720 | 3 high | **Unfixed; CLI feature not called.** Debian identifies overflow in `infocmp` analyze_string, not arbitrary uses of terminal libraries. No infocmp invocation from PDF worker. [Debian](https://security-tracker.debian.org/tracker/CVE-2025-69720). |
| perl-base `5.36.0-7+deb12u4`, CVE-2026-9538 | 1 high | **Upgrade did not fix this advisory.** Archive::Tar crafted-header allocation; no Perl/tar parsing in PDF flow, and no perl-modules package listed. Avoid claiming actual Archive::Tar file absence without filesystem evidence. Debian still defers bookworm fix. [Debian](https://security-tracker.debian.org/tracker/CVE-2026-9538). |

## Node families

| Package | Matches | Disposition / next action |
|---|---:|---|
| MCP SDK 1.29.0 / server 2.0.0 | 5 high | OAuth credential binding, tasks, HTTP validation, shared server instances. Extractor exposes its own `node:http` `/extract`, not MCP endpoints; imported package presence does not activate these. **Site remains different:** its `/api/mcp` uses the v2 wrapper. Follow up upstream with server 2.3.0 plus enabled `maxToolInputElements` and bounded `maxRequestBodySize`; upgrade alone is insufficient. Existing per-request factory mitigates shared-instance issue. |
| adm-zip 0.5.18 | 5 high | ZIP allocation/decompression and extraction permission bits. Paths previously traced to ONNX installer and Crawlee fingerprint data. Supported worker selects unpdf, disables OCR and OCR fallback, and does not unpack user ZIPs. A PDF embedded ZIP does not by itself call adm-zip. Keep upstream 0.6.1 migration tracked; reassess if OCR/model installation or arbitrary archive handling is added. |
| braces 3.0.3 | 1 high | Untrusted glob recursion; worker passes fixed local filenames and numeric page indexes, no caller-provided glob. No patched version in advisory. Track upstream and avoid untrusted pattern evaluation. |
| nodemailer 7.0.13 | 4 high | Mail raw/URL/file input, address parsing, OAuth TLS. Extractor sends no mail and has no mail credentials passed to child. Upstream mail adapter needs compatible migration to 10.0.6 to clear all supplied highs. Do not extend this disposition to site's mail features. |

## Supported execution boundary and limitations

Reviewed entrypoint uses PDF reader provider `unpdf`, `enableOCR:false`, and per-page `skipOCRFallback:true`; only Node is spawned with input/output filenames. Worker limits input to 10 MiB, pages to 20, text to 120,000 chars, output to 1 MB, with a 75-second deadline and one active request. **Page count/text bounds occur after parsing and are not a general memory bound.** A pathological PDF may still cause child/container resource exhaustion; this is a residual availability property, not a demonstrated remaining CVE exploit.

Checked-in Kubernetes deployment supplies non-root UID 10001, no privilege escalation, all capabilities dropped, RuntimeDefault seccomp, read-only root, 512 MiB memory limit, bounded temp storage, no service-account token, and ingress restrictions/deny-all egress. These materially limit consequences **when actually enforced by the deployment and network plugin**. Dockerfile alone establishes non-root execution but not those cluster controls. No assertion that a deployment has been verified is made here.

The hardened Dockerfile removes global npm/npx and checks package-manager absence. That reduces unused attack surface, but broad site dependencies are still installed in the extractor. A future minimal published extraction closure can remove unrelated MCP/mail/crawling/tooling packages. Do not use that future work as a reason to hide current findings.

Recommended receipt wording: “Hardened extractor scan retains 57 Debian and 15 Node high/critical matches. Critical zlib1g CVE-2023-45853 is non-applicable to Debian bookworm's binary per Debian tracker. Remaining findings are documented by feature prerequisite; no remaining uploaded-PDF exploit path was established in read-only analysis. Base/upstream follow-ups remain open; runtime isolation and limits are required. No zero-vulnerability claim.”
