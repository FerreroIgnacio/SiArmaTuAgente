import fs from './fs.js';
export const { readFile, writeFile, unlink, mkdir, stat, rm, access } = fs.promises;
export default fs.promises;
