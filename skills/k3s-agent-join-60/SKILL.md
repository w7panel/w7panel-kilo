---
name: k3s-agent-join-60
description: 将 Debian worker 172.16.1.123 通过公网加入 60 生产 K3s 集群，并验证 Cilium 与 Kilo 跨网络互联；不适用于建立第二个独立集群。
---

# 172.16.1.123 加入 60 主集群

目标：将 `172.16.1.123` 加入 60 的**同一个** K3s 集群，作为 worker agent。60 的 `server1` 使用 K3s `v1.36.5+k3s1`、Cilium `v1.16.4`、Kilo `0.7.0`。worker 为 Debian 13，主网卡地址 `172.16.1.123/23`，现有 Docker 网段 `172.20.0.0/16`；首次加入前未安装 K3s。不要在 worker 上安装第二个 K3s server、独立 Kilo Peer 或独立 CNI。

60 API 证书包含 `server1` DNS SAN，但不包含 `60.166.152.115` 公网 IP。worker 使用 `/etc/hosts` 映射 `server1` 到该公网 IP，以 `https://server1:6443` 加入；无需为增加 TLS SAN 重启生产 server。有关 UDP 51820 转发与节点注解，先读 [60 Kilo 配置](../kilo-60-cluster-mesh/SKILL.md)。

## 预检

在 60 上确认 `server1` Ready、Kilo/Cilium Ready、K3s 版本及公网 6443 和 UDP 51820 的转发状态。仅在 60 主机本地读取 `/var/lib/rancher/k3s/server/node-token`；不要把 token 贴进聊天、仓库或命令行历史。执行前核对 60 Node 的现有 Kilo 注解并设置公网 `force-endpoint`。

在 worker 上确认 `ip -4 -brief addr` 显示主网卡地址，`ip -4 route` 无与 60 Pod `10.42.0.0/16`、Service `10.43.0.0/16`、Kilo `10.4.0.0/16` 冲突的本地路由；`172.20.0.0/16` Docker 网段保留。确认 K3s 未运行、WireGuard 内核支持、磁盘空间充足，并记录已有 `/etc/rancher/k3s/registries.yaml`，不要覆盖它。先检查 `server1` 是否已有 `/etc/hosts` 记录；如无，加入：

```text
60.166.152.115 server1
```

验证 `getent hosts server1` 返回该公网 IP。K3s API 使用集群自签 CA，尚未取得 CA 的主机可用 `curl -k --fail --silent --show-error https://server1:6443/ping` **仅检查网络连通性**，应返回 `pong`；这不替代 K3s 安装时通过 node-token 校验集群 CA。再核对 agent 主机名在集群内未占用。

## 加入

在 worker 上创建权限 `0600` 的 `/etc/rancher/k3s/config.yaml`，保留已有 `registries.yaml`，内容如下。`<NODE_TOKEN>` 由操作者从 60 主机本地读取后直接填入；不要输出文件内容或把 token 放进安装命令参数。

```yaml
server: https://server1:6443
token: <NODE_TOKEN>
node-ip: 172.16.1.123
```

填入 token 后，使用官方安装脚本和与 server 相同的版本安装 agent（安装前审阅脚本来源）：

```sh
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='v1.36.5+k3s1' sh -s - agent
```

如果 GitHub release 下载慢或失败，先根据 `uname -m` 选择该版本对应的 K3s 二进制和 SHA256 文件。可按 `$github-proxy-download` 将**完整** GitHub release URL 加上 `https://gh-proxy.org/` 前缀，例如 amd64 的 `https://gh-proxy.org/https://github.com/k3s-io/k3s/releases/download/v1.36.5+k3s1/k3s`。校验 SHA256，安装为 `/usr/local/bin/k3s` 后用 `INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION='v1.36.5+k3s1'` 运行同一安装脚本；不要跳过校验或执行未知版本。若 token 尚未填写，先加 `INSTALL_K3S_SKIP_START=true` 完成安装，随后 `systemctl disable k3s-agent`，避免重启时误启动；填入 token 后执行 `systemctl enable --now k3s-agent`。代理仅用于 GitHub release 资源，不用于 node-token 或 kubeconfig。

`systemctl status k3s-agent` 应为 active。若失败，读 `journalctl -u k3s-agent -n 100 --no-pager`；不能只凭公网 TCP 9345 探测结果判断失败，按实际 agent 日志定位。避免将配置文件或日志中的 token 转贴到聊天。

## 接入 Kilo 并验收

在 60 集群查询新增 Node 的名称、InternalIP、版本、Ready 状态，确认 Cilium 和 Kilo DaemonSet 各有两个 Ready Pod。按 [60 Kilo 配置](../kilo-60-cluster-mesh/SKILL.md)给新增 Node 添加独立 `location` 和 `persistent-keepalive=25`。两端若已安装 `wireguard-tools`，检查 `wg show kilo0` 的握手与收发计数；未安装时先用 Kilo 日志、`ip route get` 和实际流量验证，不必为 Kilo 运行而安装 `wg` 命令；从分别运行在两节点的 Pod 测试跨节点 Pod IP、实际 TCP 服务与所需 ClusterIP。不要以 Node Ready 或握手单独作为验收。访问 212 数据库的额外配置见 [数据库网关](../kilo-vpc-database-gateway/SKILL.md)。

## 退出与回滚

若 worker 上已有业务，先按集群策略迁移或排空，再删除 Node，运行 agent 主机的 `/usr/local/bin/k3s-agent-uninstall.sh`。该脚本可能清除 K3s 生成的数据和网络状态；执行前确认未被其他用途复用。仅恢复本次新增的 `/etc/hosts` 行和 K3s 配置；保留预先存在的 `registries.yaml` 与 Docker 网络。60 上按预检记录恢复 Kilo 注解，不重启 server。
