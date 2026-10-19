'use strict';

/**
 * 知识库备份与恢复
 *
 *   node scripts/backup.js              创建备份
 *   node scripts/backup.js --list       列出已有备份
 *   node scripts/backup.js --restore <名称>   恢复指定备份
 *
 * 为什么需要：
 *   教师端的删除是**不可撤销**的（整文件覆盖写，没有版本历史）。
 *   误删一条通知、或改坏了内容，目前没有任何办法找回。
 *   社区系统的知识库是长期积累的资产，必须有备份。
 *
 * 备份内容：data/ 下所有 .json 文件（不含 _logs 日志）
 * 存放位置：backups/ 目录，按时间戳命名
 * 保留策略：默认保留最近 30 份，自动清理更早的
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(ROOT, 'backups');

const KEEP = 30;   // 保留份数

// 不备份的文件（日志是运行数据，不是内容资产）
const SKIP = new Set(['_logs']);

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 列出 data 下需要备份的 json */
function dataFiles() {
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .filter((n) => !SKIP.has(n));
}

// ---------- 创建备份 ----------

function create(label) {
  ensureDir();
  const files = dataFiles();
  if (!files.length) {
    console.log('  ✗ data/ 下没有可备份的 json 文件');
    return null;
  }

  const name = `backup-${stamp()}${label ? '-' + label : ''}`;
  const dir = path.join(BACKUP_DIR, name);
  fs.mkdirSync(dir, { recursive: true });

  let totalBytes = 0;
  const manifest = { createdAt: new Date().toISOString(), files: [] };

  for (const f of files) {
    const src = path.join(DATA_DIR, f);
    const dst = path.join(dir, f);
    fs.copyFileSync(src, dst);
    const size = fs.statSync(src).size;
    totalBytes += size;
    manifest.files.push({ name: f, size });
  }

  // 写清单，便于恢复时核对
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 统计各文件条数，写进清单方便人工确认
  const counts = {};
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      counts[f] = Array.isArray(j) ? j.length : 1;
    } catch { counts[f] = '?'; }
  }

  console.log('='.repeat(56));
  console.log('  知识库备份完成');
  console.log('='.repeat(56));
  console.log(`  备份名称：${name}`);
  console.log(`  文件数量：${files.length} 个，共 ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log('');
  console.log('  内容：');
  for (const [f, n] of Object.entries(counts)) {
    console.log(`    ${f.padEnd(18)} ${n} 条`);
  }
  console.log('');
  console.log(`  位置：${dir}`);
  console.log('');

  cleanOld();
  return name;
}

// ---------- 清理旧备份 ----------

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
    .map((e) => {
      const p = path.join(BACKUP_DIR, e.name);
      const st = fs.statSync(p);
      let count = 0;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(p, '_manifest.json'), 'utf8'));
        count = m.files.length;
      } catch { /* 旧格式无清单 */ }
      return { name: e.name, mtime: st.mtime, count };
    })
    .sort((a, b) => b.name.localeCompare(a.name));   // 名称含时间戳，倒序即最新在前
}

function cleanOld() {
  const all = listBackups();
  if (all.length <= KEEP) return;
  const remove = all.slice(KEEP);
  for (const b of remove) {
    fs.rmSync(path.join(BACKUP_DIR, b.name), { recursive: true, force: true });
  }
  console.log(`  已清理 ${remove.length} 份旧备份（保留最近 ${KEEP} 份）`);
}

// ---------- 列出 ----------

function list() {
  const all = listBackups();
  console.log('='.repeat(56));
  console.log('  已有备份');
  console.log('='.repeat(56));
  if (!all.length) {
    console.log('  （还没有备份）');
    console.log('');
    console.log('  创建备份：node scripts/backup.js');
    console.log('');
    return;
  }
  console.log('  名称'.padEnd(32) + '文件数'.padEnd(8) + '时间');
  console.log('  ' + '-'.repeat(54));
  for (const b of all) {
    const t = b.mtime.toLocaleString('zh-CN');
    console.log('  ' + b.name.padEnd(30) + String(b.count).padEnd(8) + t);
  }
  console.log('');
  console.log(`  共 ${all.length} 份，位置：${BACKUP_DIR}`);
  console.log('  恢复：node scripts/backup.js --restore <名称>');
  console.log('');
}

// ---------- 恢复 ----------

function restore(name) {
  if (!name) {
    console.log('  ✗ 请指定要恢复的备份名称，如：');
    console.log('      node scripts/backup.js --restore backup-20261018-120000');
    console.log('    先运行 node scripts/backup.js --list 查看可用备份');
    return false;
  }

  const dir = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(dir)) {
    console.log(`  ✗ 找不到备份：${name}`);
    console.log('    运行 node scripts/backup.js --list 查看可用备份');
    return false;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_manifest.json');
  if (!files.length) {
    console.log(`  ✗ 备份目录里没有可恢复的文件：${dir}`);
    return false;
  }

  // 恢复前先把当前状态备份一次，避免恢复错了无法回头
  const safety = create('before-restore');

  console.log('');
  console.log('='.repeat(56));
  console.log('  正在恢复');
  console.log('='.repeat(56));
  console.log(`  来源：${name}`);
  if (safety) console.log(`  当前状态已另存为：${safety}`);
  console.log('');

  for (const f of files) {
    const src = path.join(dir, f);
    const dst = path.join(DATA_DIR, f);
    // 原子写入：先写临时文件再改名
    const tmp = dst + '.tmp-' + process.pid;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);

    let count = '?';
    try {
      const j = JSON.parse(fs.readFileSync(dst, 'utf8'));
      count = Array.isArray(j) ? j.length : 1;
    } catch { /* ignore */ }
    console.log(`  ✓ ${f.padEnd(18)} ${count} 条`);
  }

  console.log('');
  console.log('  ⚠️ 如果服务正在运行，请重启服务或让教师端刷新，');
  console.log('     否则内存中的旧数据仍在使用（教师端任一保存操作会触发重新加载）。');
  console.log('');
  return true;
}

// ---------- 入口 ----------

(function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('');
    console.log('  知识库备份与恢复');
    console.log('');
    console.log('    node scripts/backup.js                    创建备份');
    console.log('    node scripts/backup.js --list             列出已有备份');
    console.log('    node scripts/backup.js --restore <名称>   恢复指定备份');
    console.log('');
    console.log(`  备份保存在 backups/ 目录，自动保留最近 ${KEEP} 份。`);
    console.log('  备份内容为 data/ 下所有 .json（不含问答日志）。');
    console.log('');
    return;
  }

  if (args.includes('--list') || args.includes('-l')) {
    list();
    return;
  }

  const ri = args.indexOf('--restore');
  if (ri >= 0) {
    const name = args[ri + 1];
    process.exit(restore(name) ? 0 : 1);
  }

  // 默认：创建备份
  const name = create(args[0] && !args[0].startsWith('-') ? args[0] : '');
  process.exit(name ? 0 : 1);
})();
