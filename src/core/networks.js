// Network parameters. Every default server below was checked to answer from a file:// page:
// Esplora REST (https://) for Bitcoin, Fulcrum/Electrum over WebSocket (wss://) for Bitcoin Cash.
const MAIN_XPUB = { public: 0x0488b21e, private: 0x0488ade4 };
const TEST_XPUB = { public: 0x043587cf, private: 0x04358394 };

const btcMain = { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
const btcTest = { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export const NETWORKS = [
  {
    id: 'btc', coin: 'btc', name: 'Bitcoin', symbol: 'BTC', testnet: false, coinType: 0, bip32: MAIN_XPUB, ...btcMain,
    servers: ['https://mempool.space/api', 'https://blockstream.info/api'],
    explorerTx: 'https://mempool.space/tx/{txid}',
  },
  {
    id: 'btc-testnet4', coin: 'btc', name: 'Bitcoin Testnet4', symbol: 'tBTC', testnet: true, coinType: 1, bip32: TEST_XPUB, ...btcTest,
    servers: ['https://mempool.space/testnet4/api'],
    explorerTx: 'https://mempool.space/testnet4/tx/{txid}',
  },
  {
    id: 'btc-signet', coin: 'btc', name: 'Bitcoin Signet', symbol: 'sBTC', testnet: true, coinType: 1, bip32: TEST_XPUB, ...btcTest,
    servers: ['https://mempool.space/signet/api'],
    explorerTx: 'https://mempool.space/signet/tx/{txid}',
  },
  {
    id: 'btc-regtest', coin: 'btc', name: 'Bitcoin Regtest', symbol: 'rBTC', testnet: true, coinType: 1, bip32: TEST_XPUB, ...btcTest, bech32: 'bcrt',
    servers: [], explorerTx: '',
  },
  {
    id: 'bch', coin: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', testnet: false, coinType: 145, bip32: MAIN_XPUB, ...btcMain, cashaddr: 'bitcoincash',
    servers: ['wss://bch.imaginary.cash:50004', 'wss://electrum.imaginary.cash:50004', 'wss://bch.loping.net:50004', 'wss://fulcrum.greyh.at:50004'],
    explorerTx: 'https://blockchair.com/bitcoin-cash/transaction/{txid}',
  },
  {
    id: 'bch-chipnet', coin: 'bch', name: 'Bitcoin Cash Chipnet', symbol: 'tBCH', testnet: true, coinType: 1, bip32: TEST_XPUB, ...btcTest, cashaddr: 'bchtest',
    servers: ['wss://chipnet.imaginary.cash:50004', 'wss://chipnet.bch.ninja:50004'],
    explorerTx: '',
  },
  {
    id: 'bch-testnet4', coin: 'bch', name: 'Bitcoin Cash Testnet4', symbol: 'tBCH', testnet: true, coinType: 1, bip32: TEST_XPUB, ...btcTest, cashaddr: 'bchtest',
    servers: ['wss://testnet4.imaginary.cash:50004'],
    explorerTx: '',
  },
  {
    id: 'bch-regtest', coin: 'bch', name: 'Bitcoin Cash Regtest', symbol: 'rBCH', testnet: true, coinType: 1, bip32: TEST_XPUB, ...btcTest, cashaddr: 'bchreg',
    servers: [], explorerTx: '',
  },
];

export const getNetwork = (id) => NETWORKS.find((n) => n.id === id);

/** The subset @scure/btc-signer expects. */
export const scureNet = (net) => ({ bech32: net.bech32, pubKeyHash: net.pubKeyHash, scriptHash: net.scriptHash, wif: net.wif });

export const explorerTxUrl = (net, txid) => (net?.explorerTx ? net.explorerTx.replace('{txid}', txid) : '');

// Address/script types of our own accounts. BIP44/49/84/86 purposes.
export const SCRIPT_TYPES = {
  pkh: { purpose: 44, label: 'Legacy (P2PKH)' },
  'sh-wpkh': { purpose: 49, label: 'Nested SegWit (P2SH-P2WPKH)' },
  wpkh: { purpose: 84, label: 'Native SegWit (P2WPKH)' },
  tr: { purpose: 86, label: 'Taproot (P2TR)' },
};

export const typesFor = (net) => (net.coin === 'bch' ? ['pkh'] : ['wpkh', 'tr', 'sh-wpkh', 'pkh']);
export const defaultType = (net) => (net.coin === 'bch' ? 'pkh' : 'wpkh');
