// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
// 客户端目录与服务端轻量转发共用固定上游和分页边界，不接受任意代理地址。
export const MODELSCOPE_MCP_CATALOG_URL = 'https://modelscope.cn/api/v1/dolphin/mcpServers';
export const MODELSCOPE_MCP_PROXY_PATH = '/api/modelscope-mcp';
export const MODELSCOPE_MCP_PAGE_SIZE = 30;
export const MODELSCOPE_MCP_MAX_PAGES = 5;
