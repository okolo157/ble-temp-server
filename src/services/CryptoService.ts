import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import dotenv from 'dotenv';

dotenv.config();

class CryptoService {
    private keyPair: nacl.SignKeyPair;

    constructor() {
        const secretKeyBase64 = process.env.SERVER_SECRET_KEY;
        if (secretKeyBase64) {
            this.keyPair = nacl.sign.keyPair.fromSecretKey(naclUtil.decodeBase64(secretKeyBase64));
        } else {
            // For development, generate a new one if not provided
            this.keyPair = nacl.sign.keyPair();
            console.warn('⚠️ No SERVER_SECRET_KEY found, generated temporary key pair');
            console.log('Public Key:', naclUtil.encodeBase64(this.keyPair.publicKey));
            console.log('Secret Key:', naclUtil.encodeBase64(this.keyPair.secretKey));
        }
    }

    getPublicKey(): string {
        return naclUtil.encodeBase64(this.keyPair.publicKey);
    }

    sign(message: string): string {
        const messageUint8 = naclUtil.decodeUTF8(message);
        const signature = nacl.sign.detached(messageUint8, this.keyPair.secretKey);
        return naclUtil.encodeBase64(signature);
    }

    verify(message: string, signature: string, publicKey: string): boolean {
        const messageUint8 = naclUtil.decodeUTF8(message);
        const signatureUint8 = naclUtil.decodeBase64(signature);
        const publicKeyUint8 = naclUtil.decodeBase64(publicKey);
        return nacl.sign.detached.verify(messageUint8, signatureUint8, publicKeyUint8);
    }
}

export default new CryptoService();
