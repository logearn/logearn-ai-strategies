import React from 'react';
import { Alert } from 'antd';

// 错误边界：某个面板渲染崩溃时，只把这个面板换成一条错误提示，而不是整个 app 白屏。
// 这个工具渲染的是用户上传的任意 JSON + 用户写的策略代码，出错在所难免——
// 一处崩溃拖垮整页（像"选个 CA 就白屏"）是绝对不能接受的。每个大面板都该包一层。
export default class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('面板渲染出错：', err, info); }
  // key 变化（比如切换了 CA / 重新分析）时清掉错误，让面板重新尝试渲染
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (this.state.err) {
      return (
        <Alert type="error" showIcon style={{ margin: 12 }}
          message={this.props.title || '这个面板渲染出错了'}
          description={<div style={{ fontSize: 12 }}>
            {String(this.state.err.message || this.state.err)}
            <br /><span style={{ opacity: .6 }}>其它面板不受影响；换个输入或重新分析通常能恢复。</span>
          </div>} />
      );
    }
    return this.props.children;
  }
}
