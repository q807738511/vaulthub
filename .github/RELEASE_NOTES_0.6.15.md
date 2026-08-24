# VaultHub 0.6.15

## 本地媒体格式扩展

- 漫画库支持 EPUB、MOBI、ZIP、CBZ、PDF、RAR、CBR、7Z、CB7、JPG/PNG 等散图、CPG、LZH、CBL、TAR、CBT。
- 电子书库支持 EPUB、PDF、MOBI、AZW/AZW3、CHM、EXE、UMD、JAR/JAD、CAJ、PDG、DJVU、CEB、DOC/DOCX、XPS、TXT。
- 后端补充对应 MIME 类型，未知或浏览器无法解析格式保持下载/外部打开兜底。

## 影视本地媒体库

- 影视栏目新增“本地媒体库 / 外连服务”切换，可配置容器内已挂载的本地影视目录。
- 支持读取 MP4、MKV、AVI、MOV、M4V、WEBM、TS/M2TS、WMV、FLV、MPG/MPEG、RMVB、ISO 等影片文件。
- 本地影视文件可直接在页面内播放；不支持浏览器原生播放的格式保留下载/外部播放器兜底。

## 影视刮削

- 影视刮削默认使用豆瓣建议接口，刮削失败时以文件名、年份等信息兜底展示。
- 新增 `/api/media/scrapers` 暴露刮削器状态。
- 新增 `/api/media/tmdb` 代理接口；只有配置环境变量 `TMDB_API_KEY` 后才启用 TMDB 刮削。

## 校验

- 新增格式白名单和影视本地库前端回归测试。
- 新增后端黑盒测试覆盖 movie 类型、视频 Range 播放、MIME 和 TMDB 环境变量门控。
