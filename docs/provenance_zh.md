# 来源说明

EdgeSSH Workbench 使用了新的包名、架构、部署配置和源码目录。参考仓库不是运行时依赖，其 Git 历史也没有嵌入本项目。

## 设计参考

| 参考项目 | 审阅的 commit | 许可证 | 影响范围 |
| --- | --- | --- | --- |
| `cmliu/CF-Workers-WebSSH` | `17288a98c92433f07207ae717fe3ec00be967e5c` | Apache-2.0 | Worker 原生 SSH 传输、主机密钥和会话安全行为 |
| `619dev/tafeng` | `d53d8cedfdc41df71cad5758e87341dc1568e7e2` | MIT | 工作台布局、React/xterm 集成、SFTP 和监控产品形态 |

需求评审在 [`../../WEBSSH_WORKBENCH_REQUIREMENTS.md`](../../WEBSSH_WORKBENCH_REQUIREMENTS.md) 中对可复用行为和弃用的实现模式进行了分类。新的实现使用共享 contracts、D1、加密凭据记录、按会话创建的 Durable Objects 和二进制传输帧，而不是直接引入任一参考应用。

## 调整后的兼容 shim

`apps/worker/shims/cpu-features` 沿用了 Tafeng 的两行无原生扩展行为，使采用 MIT 许可证的 `ssh2` 包能够在 Workers 中运行。Tafeng 的 MIT 署名保留在 `THIRD_PARTY_NOTICES.md` 中。

未来如果复制或实质性改编参考项目中的代码，必须在发布前于此处记录上游文件、commit、日期、具体变更和适用许可证。
