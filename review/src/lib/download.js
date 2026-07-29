// 统一的文件下载工具：new Blob → 临时 <a> → 点击 → 清理，这套流程曾被 8 个组件各自手写，
// 写法还互相不一致（有的不 append 到 DOM、有的用 a.remove() 有的用 removeChild）。
// 收进一处以后要改兼容性写法只用改这一个地方（2026-07-29 从各组件抽出）。
export function downloadBlob(content, filename, mimeType) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadText(text, filename, mimeType = 'text/plain;charset=utf-8;') {
  downloadBlob(text, filename, mimeType);
}

export function downloadJson(obj, filename, { pretty = true } = {}) {
  const text = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  downloadBlob(text, filename, 'application/json');
}
