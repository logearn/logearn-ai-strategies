// 统一的剪贴板复制工具：navigator.clipboard.writeText 包一层 try/catch，这套写法在 8 处
// 组件里各自重复过，写法还不一致（有的 await/try-catch 处理失败，有的用可选链裸调用、
// 复制真失败了也照样弹"已复制"）。这里只负责复制本身，成功/失败提示文案交给调用方
// （各处提示语义不同，不能强行统一成一句话）。2026-07-29 从各组件抽出。
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
