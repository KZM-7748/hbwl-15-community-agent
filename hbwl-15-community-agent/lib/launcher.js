'use strict';

/**
 * 本机程序唤起（WPS 等）
 *
 * 背景：社区开会常用 WPS，希望从智能体界面直接跳过去。
 *
 * ── 技术现实 ──────────────────────────────────────────────
 *   浏览器出于安全限制，**不能**直接启动本机任意程序。
 *   可行的办法有两条，本项目两条都实现了：
 *
 *   1. URL 协议（推荐，纯前端）
 *      WPS 注册了 ksowps:// / ksowpp:// / ksoet:// 等协议，
 *      浏览器点链接即可唤起（会弹一次「是否打开」的确认，这是系统行为）。
 *      实测：关闭 WPS 后点击 ksowps://，进程从 0 → 2，确认可用。
 *
 *   2. 本机 HTTP 接口（兜底）
 *      若协议被浏览器拦截或用户点了取消，可调用本服务的 /api/launch。
 *      **仅允许来自本机的请求** —— 否则任何能访问这个服务的人
 *      都能在你的电脑上启动程序，这是严重的安全问题。
 *
 * ── 为什么限制本机 ────────────────────────────────────────
 *   这个服务默认监听 0.0.0.0（同学要从手机访问）。
 *   如果 /api/launch 不限制来源，同网段任何人构造一个请求
 *   就能远程在你的机器上执行命令。因此只认 127.0.0.1 / ::1。
 */

const { spawn } = require('child_process');
const os = require('os');

/**
 * 支持的唤起目标。
 * protocol 用于前端直接跳转；exe 用于本机接口兜底启动。
 */
const TARGETS = {
  wps: { name: 'WPS 文字', protocol: 'ksowps://', exe: 'wps.exe' },
  wpp: { name: 'WPS 演示', protocol: 'ksowpp://', exe: 'wpp.exe' },
  et: { name: 'WPS 表格', protocol: 'ksoet://', exe: 'et.exe' },
};

/**
 * WPS 的安装根目录（按优先级）。
 * 注意：WPS 会保留多个版本目录（实测同时存在 11.1 / 12.1 等），
 * 需要遍历所有版本目录找可执行文件，不能写死某个版本号。
 */
function wpsRoots() {
  const roots = [];
  if (process.env.LOCALAPPDATA) {
    roots.push(require('path').join(process.env.LOCALAPPDATA, 'Kingsoft', 'WPS Office'));
  }
  roots.push('C:\\Program Files\\Kingsoft\\WPS Office');
  roots.push('C:\\Program Files (x86)\\Kingsoft\\WPS Office');
  return roots;
}

/**
 * 查找某个 WPS 组件的可执行文件。
 *
 * 目录结构：<root>\<版本号>\office6\<exe>
 * 版本号目录可能有多个，优先取版本号最大的（通常是最新安装）。
 */
function findExe(targetKey) {
  const t = TARGETS[targetKey];
  if (!t) return null;
  const fs = require('fs');
  const path = require('path');

  for (const root of wpsRoots()) {
    let entries;
    try {
      if (!fs.statSync(root).isDirectory()) continue;
      entries = fs.readdirSync(root);
    } catch { continue; }

    // 只挑版本号目录（形如 11.1.0.10009），按版本**从新到旧**排序
    const versions = entries
      .filter((e) => /^\d+(\.\d+)+$/.test(e))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pb[i] || 0) - (pa[i] || 0);   // 降序：新版本在前
          if (d) return d;
        }
        return 0;
      });

    for (const v of versions) {
      const exe = path.join(root, v, 'office6', t.exe);
      try {
        if (fs.statSync(exe).isFile()) return exe;
      } catch { /* 继续找下一个版本 */ }
    }
  }
  return null;
}

/** 是否来自本机 */
function isLocalRequest(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** 检测本机是否装了 WPS（供前端决定显示哪些入口） */
function detect() {
  const out = { available: false, targets: [] };
  for (const key of Object.keys(TARGETS)) {
    const exe = findExe(key);
    if (exe) {
      out.available = true;
      out.targets.push({
        key,
        name: TARGETS[key].name,
        protocol: TARGETS[key].protocol,
        path: exe,
      });
    }
  }
  return out;
}

/**
 * 启动目标程序。
 * 优先用 URL 协议（交给系统处理），失败再直接执行 exe。
 * @returns {{ok:boolean, method?:string, error?:string}}
 */
function launch(targetKey) {
  const t = TARGETS[targetKey];
  if (!t) return { ok: false, error: '不支持的目标：' + targetKey };

  if (process.platform !== 'win32') {
    return { ok: false, error: '本机程序唤起目前仅支持 Windows' };
  }

  // 方式一：交给系统按协议唤起（最稳妥，走 WPS 自己的启动器）
  try {
    spawn('cmd', ['/c', 'start', '', t.protocol], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return { ok: true, method: 'protocol' };
  } catch (e) {
    // 继续尝试方式二
  }

  // 方式二：直接执行找到的 exe
  const exe = findExe(targetKey);
  if (exe) {
    try {
      spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { ok: true, method: 'exe', path: exe };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { ok: false, error: '未找到 WPS 安装位置，请确认已安装 WPS Office' };
}

module.exports = { detect, launch, isLocalRequest, TARGETS };
