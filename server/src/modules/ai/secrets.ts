/** Credentials at rest: shared with accounts (two-step sign-in secrets) since API 0.46.0, so it lives in infrastructure. */
export { SecretBox, secretsKey } from "../../infrastructure/crypto/secretBox.js";
