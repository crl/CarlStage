import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { merge } from '../server/store.mjs';

if (process.platform !== 'win32' || !process.env.APPDATA) throw new Error('此迁移命令目前仅支持 Windows。');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, '.local-runs');
const target = join(process.env.APPDATA, 'com.carlstage.desktop');
const sourceStore = join(source, 'projects.json');
try { await stat(sourceStore); } catch { throw new Error('没有找到项目文件。请先用原浏览器打开新版开发页面，完成 IndexedDB 迁移。'); }
await mkdir(target, { recursive: true });
const incoming = JSON.parse(await readFile(sourceStore, 'utf8'));
let current = { projects: [], library: [] };
try { current = JSON.parse(await readFile(join(target, 'projects.json'), 'utf8')); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const merged = merge(current, incoming);
const temporary = join(target, 'projects.json.' + randomUUID() + '.tmp');
await writeFile(temporary, JSON.stringify(merged), 'utf8');
await rename(temporary, join(target, 'projects.json'));
try { await cp(join(source, 'settings.json'), join(target, 'settings.json'), { force: false, errorOnExist: true }); }
catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ERR_FS_CP_EEXIST') throw error; }
try { await cp(join(source, 'media'), join(target, 'media'), { recursive: true, force: false }); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const store = JSON.parse(await readFile(join(target, 'projects.json'), 'utf8'));
console.log('桌面数据目录：' + target);
console.log('项目数：' + (store.projects?.length || 0));
