// fs en memoria: Baileys usa archivos temporales para cifrar y subir media
import { fs } from 'memfs';
fs.mkdirSync('/tmp', { recursive: true });
export const { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, promises, WriteStream, ReadStream } = fs;
export default fs;
