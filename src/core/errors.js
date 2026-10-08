// Errors carry an i18n key plus parameters so the UI can show them in either language.
export class WalletError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.name = 'WalletError';
    this.key = key;
    this.params = params;
  }
}
