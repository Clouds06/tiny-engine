/**
 * Zip Slip 防护测试：含路径穿越条目（../）的压缩包必须被拒绝，
 * 正常压缩包正常解压。零密钥。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { extractZipToTempDir } = require('../src/file-collection/component-code-file-filter');

test('含 ../ 路径穿越条目的压缩包 → 拒绝（抛错），不写出目录外文件', () => {
  // addFile 会规范化掉 ../，故先占位再改 entryName 造出真实的穿越条目
  const zip = new AdmZip();
  zip.addFile('placeholder.txt', Buffer.from('pwned'));
  zip.getEntries()[0].entryName = '../evil-zipslip-sentinel.txt';
  const buf = zip.toBuffer();

  assert.throws(() => extractZipToTempDir(buf), /路径穿越|解压失败/);

  // 确认没有真的写到 os.tmpdir() 的上一级
  const escaped = path.resolve(require('os').tmpdir(), '../evil-zipslip-sentinel.txt');
  assert.strictEqual(fs.existsSync(escaped), false);
});

test('正常压缩包 → 正常解压并落盘', () => {
  const zip = new AdmZip();
  zip.addFile('src/Button.vue', Buffer.from('<template><button/></template>'));
  const buf = zip.toBuffer();

  const dir = extractZipToTempDir(buf);
  try {
    assert.ok(fs.existsSync(path.join(dir, 'src', 'Button.vue')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
