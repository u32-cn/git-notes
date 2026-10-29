'use strict';
/* ================= 配置（默认标签三端同步义务：web/server.js、electron/backend/store.js、android GitRepo.kt 同名常量同改） ================= */
var DEFAULT_TAGS = ['待办', '已完成待办', '备忘', '日记', '杂记', '收藏', '想法', '感悟'];
var TODO_TAG = '待办';
var DONE_TODO = '已完成待办';
var MAX_IMAGES = 9;
var MAX_FILES = 9;
/* 长笔记折叠阈值（行数） */
var FOLD_LINES = 10;

/* ================= 状态 ================= */
var state = {
  ready: false,       /* 可读写（仅本机或已绑定远端） */
  stage: '',          /* fresh / cloning / local / ready */
  platform: '',       /* 服务端平台（win32/darwin/linux/android），android 隐藏「打开仓库」按钮 */
  remote: '',         /* 绑定的远端地址（仅本机为空） */
  branch: '',         /* 当前分支名（/api/status 返回；无仓库为空） */
  hasKey: false,
  posts: [],          /* 已加载微笔记（信息流，新→旧） */
  pinPosts: [],       /* 钉住的微笔记（main.json pins，默认信息流底部「📌 钉住」区块展示） */
  tags: DEFAULT_TAGS.slice(),
  filter: '',
  timeRange: null,    /* 时间段筛选 {from:'YYYY-MM-DD'|null, to:'YYYY-MM-DD'|null}，允许单端为空=开放区间 */
  query: '',          /* 搜索关键词（全库搜索） */
  searchHits: null,   /* 全库搜索结果数组；null=搜索进行中或非搜索态 */
  searchMs: 0,
  editingPath: null
};
var feed = { loading: false, noMore: false, error: '', cursor: null };  /* cursor=已加载到的月份 YYYYMM */
var syncInfo = { ahead: 0, behind: 0, lastAt: null, lastError: '', conflict: null };
var editCtx = null;   /* 卡片编辑态 */

var $ = function (s) { return document.querySelector(s); };
