# LIN 个人开发笔记网站

这是一个适合 GitHub Pages 的零依赖静态网站。网站由 `src/content` 下的 Markdown 文件生成。

## 本地构建

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

构建后打开 `dist/index.html` 即可预览，不需要启动本地服务器。

## 添加笔记

当前网站以学习笔记和个人介绍为主。

复制 `src/content/notes` 中的 Markdown 文件，保留头部字段并修改内容，然后重新运行构建命令。构建会生成页面级 SEO 元数据、`sitemap.xml`、`robots.txt`、RSS 和 404 页面。

文章头部字段：`title`、`date`、`updated`、`category`、`summary`、`tags`（用 `|` 分隔），以及可选 `reading_time`。文件名作为 slug；所有文章 URL、目录和阅读导航会自动生成。摘要用于列表和搜索结果，正文保留完整说明。

生成后的页面不依赖框架。搜索、分类和复制代码使用本地小脚本；禁用 JavaScript 仍可阅读全部文章。构建会校验本地链接、目录锚点、图片资源、JSON-LD、RSS 和站点地图，失败会阻止发布。

## 从 Obsidian 整理文章

本次整理了 37 篇技术文章，加上原有 3 篇，共 40 篇。覆盖 C#、算法、操作系统、数据库、系统设计、计算机网络和 Unity。文章作为学习整理发布，不表示项目成果或已测量的性能收益。面试、闪卡、私人项目、Unity 实验与占位稿未导入。

`scripts/public-notes.json` 是显式发布清单，记录源笔记相对路径、摘要、分类、标签和必要的技术勘误；原始笔记不会被修改。导入命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\import-public.ps1 -ObsidianRoot 'E:\NoteAsProgrammer'
```

脚本会生成网站 Markdown，并把公开稿同步到 Obsidian 的 `50_公开文章/网站文章`，其中站内引用使用完整网站 URL。之后运行构建命令即可预览。GitHub Actions 只构建仓库内的文章，不需要访问笔记库。

重复导入会重新生成清单中的 37 篇；后续修改应同步维护清单的 `edits`，或将该文从自动导入清单移除后手工维护。原有 3 篇不会被导入器覆盖。构建还会检查内部路径、未解析的 wiki 链接、空章节、代码围栏和表格列数。

默认站点地址来自 `SITE_URL` 环境变量；本地预览或部署到其他地址时可以覆盖它：

```powershell
$env:SITE_URL = 'https://example.com'
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

未配置时默认使用 `https://wangok123.github.io/lin-unity-workbench`。GitHub Actions 可通过仓库变量 `SITE_URL` 覆盖，支持自定义域名和子路径。

主页背景为本地 WebP，保留原站点使用的 [Unsplash 照片](https://images.unsplash.com/photo-1511512578047-dfb367046420)；图片仅作游戏主题背景。手机和桌面分别加载小图与大图。截图验证保存在本地 `.qa/`，不随站点部署。

## 部署

将仓库推送到 GitHub 默认分支。内置工作流会把 `dist` 发布到 GitHub Pages，在仓库设置中将 Pages 来源选择为 **GitHub Actions**。



## 自动部署

推送到 `main` 后，GitHub Actions 会自动构建并部署到 GitHub Pages。

本仓库已启用本地 `pre-push` 钩子：每次 `git push` 前都会运行构建；如果构建失败，推送会被取消。新电脑克隆仓库后执行一次：

```powershell
git config core.hooksPath .githooks
```
