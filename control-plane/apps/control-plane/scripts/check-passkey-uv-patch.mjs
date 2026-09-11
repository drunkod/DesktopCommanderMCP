import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const source = await readFile(require.resolve("@better-auth/passkey"), "utf8");
const verifierRequired = (source.match(/requireUserVerification:\s*true/g) ?? []).length;
const verifierDisabled = (source.match(/requireUserVerification:\s*false/g) ?? []).length;
const optionRequired = (source.match(/userVerification:\s*"required"/g) ?? []).length;
const optionPreferred = (source.match(/userVerification:\s*"preferred"/g) ?? []).length;
const residentRequired = (source.match(/residentKey:\s*"required"/g) ?? []).length;
const registrationFailureBadRequest = source.includes('throw APIError.from("BAD_REQUEST", PASSKEY_ERROR_CODES.FAILED_TO_VERIFY_REGISTRATION);');
const registrationFailureInternal = source.includes('throw APIError.from("INTERNAL_SERVER_ERROR", PASSKEY_ERROR_CODES.FAILED_TO_VERIFY_REGISTRATION);');
if (verifierRequired !== 2 || verifierDisabled !== 0 || optionRequired < 2 || optionPreferred !== 0 || residentRequired < 1 || !registrationFailureBadRequest || registrationFailureInternal) {
  throw new Error(`Passkey UV patch missing: verifierRequired=${verifierRequired}, verifierDisabled=${verifierDisabled}, optionRequired=${optionRequired}, optionPreferred=${optionPreferred}, residentRequired=${residentRequired}, registrationFailureBadRequest=${registrationFailureBadRequest}, registrationFailureInternal=${registrationFailureInternal}`);
}
console.log("Passkey UV patch is active for required UV and registration verification failures are non-5xx.");
