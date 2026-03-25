/**
 * Universal address derivation — one function for all secp256k1 chains.
 *
 * Encoding type and chain-specific params (HRP, version byte) are read from
 * the paymentMethods DB row, not hardcoded per chain. Adding a new chain
 * is a DB INSERT, not a code change.
 *
 * Supported encodings:
 *   - bech32:  BTC (bc1q...), LTC (ltc1q...) — params: { hrp }
 *   - p2pkh:   DOGE (D...), TRON (T...) — params: { version }
 *   - evm:     ETH, ERC-20 (0x...) — params: {}
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { publicKeyToAddress } from "viem/accounts";

export interface EncodingParams {
	/** Bech32 human-readable prefix (e.g. "bc", "ltc", "tb"). */
	hrp?: string;
	/** Base58Check version byte as hex string (e.g. "0x1e" for DOGE, "0x41" for TRON). */
	version?: string;
}

// ---------- encoding helpers ----------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58encode(data: Uint8Array): string {
	let num = 0n;
	for (const byte of data) num = num * 256n + BigInt(byte);
	let encoded = "";
	while (num > 0n) {
		encoded = BASE58_ALPHABET[Number(num % 58n)] + encoded;
		num = num / 58n;
	}
	for (const byte of data) {
		if (byte !== 0) break;
		encoded = `1${encoded}`;
	}
	return encoded;
}

function hash160(pubkey: Uint8Array): Uint8Array {
	return ripemd160(sha256(pubkey));
}

function encodeBech32(pubkey: Uint8Array, hrp: string): string {
	const h = hash160(pubkey);
	const words = bech32.toWords(h);
	return bech32.encode(hrp, [0, ...words]);
}

function encodeP2pkh(pubkey: Uint8Array, versionByte: number): string {
	const h = hash160(pubkey);
	const payload = new Uint8Array(21);
	payload[0] = versionByte;
	payload.set(h, 1);
	const checksum = sha256(sha256(payload));
	const full = new Uint8Array(25);
	full.set(payload);
	full.set(checksum.slice(0, 4), 21);
	return base58encode(full);
}

function encodeEvm(pubkey: Uint8Array): string {
	// HDKey.publicKey is SEC1 compressed (33 bytes, 02/03 prefix).
	// Ethereum addresses = keccak256(uncompressed_pubkey[1:]).slice(-20).
	// viem's publicKeyToAddress expects uncompressed (65 bytes, 04 prefix).
	// Decompress via secp256k1 point recovery before hashing.
	const hexKey = Array.from(pubkey, (b) => b.toString(16).padStart(2, "0")).join("");
	const uncompressed = secp256k1.Point.fromHex(hexKey).toBytes(false);
	const hexPubKey =
		`0x${Array.from(uncompressed, (b: number) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
	return publicKeyToAddress(hexPubKey);
}

/** Keccak256-based Base58Check (Tron-style): keccak256(uncompressed[1:]) → last 20 bytes → version + checksum → Base58 */
function encodeKeccakB58(pubkey: Uint8Array, versionByte: number): string {
	const hexKey = Array.from(pubkey, (b) => b.toString(16).padStart(2, "0")).join("");
	const uncompressed = secp256k1.Point.fromHex(hexKey).toBytes(false);
	const hash = keccak_256(uncompressed.slice(1));
	const addressBytes = hash.slice(-20);
	const payload = new Uint8Array(21);
	payload[0] = versionByte;
	payload.set(addressBytes, 1);
	const checksum = sha256(sha256(payload));
	const full = new Uint8Array(25);
	full.set(payload);
	full.set(checksum.slice(0, 4), 21);
	return base58encode(full);
}

// ---------- public API ----------

/**
 * Derive a deposit address from an xpub at a given BIP-44 index.
 * Path: xpub / 0 / index (external chain).
 * No private keys involved.
 *
 * @param xpub - Extended public key
 * @param index - Derivation index (0, 1, 2, ...)
 * @param addressType - Encoding type: "bech32", "p2pkh", "evm"
 * @param params - Chain-specific encoding params from DB (parsed JSON)
 */
export function deriveAddress(xpub: string, index: number, addressType: string, params: EncodingParams = {}): string {
	if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid derivation index: ${index}`);

	const master = HDKey.fromExtendedKey(xpub);
	const child = master.deriveChild(0).deriveChild(index);
	if (!child.publicKey) throw new Error("Failed to derive public key");

	switch (addressType) {
		case "bech32": {
			if (!params.hrp) throw new Error("bech32 encoding requires 'hrp' param");
			return encodeBech32(child.publicKey, params.hrp);
		}
		case "p2pkh": {
			if (!params.version) throw new Error("p2pkh encoding requires 'version' param");
			const versionByte = Number(params.version);
			if (!Number.isInteger(versionByte) || versionByte < 0 || versionByte > 255)
				throw new Error(`Invalid p2pkh version byte: ${params.version}`);
			return encodeP2pkh(child.publicKey, versionByte);
		}
		case "keccak-b58check": {
			if (!params.version) throw new Error("keccak-b58check encoding requires 'version' param");
			const versionByte = Number(params.version);
			if (!Number.isInteger(versionByte) || versionByte < 0 || versionByte > 255)
				throw new Error(`Invalid keccak-b58check version byte: ${params.version}`);
			return encodeKeccakB58(child.publicKey, versionByte);
		}
		case "evm":
			return encodeEvm(child.publicKey);
		default:
			throw new Error(`Unknown address type: ${addressType}`);
	}
}

/**
 * Derive the treasury address (internal chain, index 0).
 * Used for sweep destinations.
 */
export function deriveTreasury(xpub: string, addressType: string, params: EncodingParams = {}): string {
	const master = HDKey.fromExtendedKey(xpub);
	const child = master.deriveChild(1).deriveChild(0); // internal chain
	if (!child.publicKey) throw new Error("Failed to derive public key");

	switch (addressType) {
		case "bech32": {
			if (!params.hrp) throw new Error("bech32 encoding requires 'hrp' param");
			return encodeBech32(child.publicKey, params.hrp);
		}
		case "p2pkh": {
			if (!params.version) throw new Error("p2pkh encoding requires 'version' param");
			const versionByte = Number(params.version);
			if (!Number.isInteger(versionByte) || versionByte < 0 || versionByte > 255)
				throw new Error(`Invalid p2pkh version byte: ${params.version}`);
			return encodeP2pkh(child.publicKey, versionByte);
		}
		case "keccak-b58check": {
			if (!params.version) throw new Error("keccak-b58check encoding requires 'version' param");
			const versionByte = Number(params.version);
			if (!Number.isInteger(versionByte) || versionByte < 0 || versionByte > 255)
				throw new Error(`Invalid keccak-b58check version byte: ${params.version}`);
			return encodeKeccakB58(child.publicKey, versionByte);
		}
		case "evm":
			return encodeEvm(child.publicKey);
		default:
			throw new Error(`Unknown address type: ${addressType}`);
	}
}

/** Validate that a string is an xpub (not xprv). */
export function isValidXpub(key: string): boolean {
	if (!key.startsWith("xpub")) return false;
	try {
		HDKey.fromExtendedKey(key);
		return true;
	} catch {
		return false;
	}
}
