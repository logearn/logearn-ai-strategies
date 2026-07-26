import { theme } from 'antd';

// AntD 主题。刻意压紧了各处间距和字号——这是个数据密集型分析工具，
// 默认主题的留白在一屏放不下几行表格。
export function makeTheme(dark) {
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: '#0a84ff',
      colorSuccess: '#30d158',
      colorWarning: '#ff9f0a',
      colorError: '#ff453a',
      borderRadius: 8,
      fontSize: 13,
      // 不指定自定义字体：产物要能 file:// 打开，不能依赖任何外部字体请求
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
    },
    components: {
      Table: { cellPaddingBlockSM: 4, cellPaddingInlineSM: 8, headerBg: dark ? '#1f1f1f' : '#fafafa' },
      Card: { bodyPadding: 16, headerFontSize: 14 },
      Tabs: { horizontalItemPadding: '10px 0', horizontalItemGutter: 24 },
      Statistic: { contentFontSize: 20 },
    },
  };
}

// Plotly 的配色要跟着 AntD 主题走，否则切换主题时图表还是旧配色
export function plotColors(dark) {
  return {
    paperBg: dark ? '#141414' : '#ffffff',
    textColor: dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.88)',
    muted: dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
    axis: {
      gridcolor: dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.08)',
      zerolinecolor: dark ? 'rgba(255,255,255,.20)' : 'rgba(0,0,0,.18)',
      linecolor: dark ? 'rgba(255,255,255,.20)' : 'rgba(0,0,0,.18)',
    },
  };
}
