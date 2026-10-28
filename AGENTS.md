# 218 集群 Kilo 现场说明

- Helm release 为 `default/w7panel-kilo`，DaemonSet 为 `default/kilo`；Peer CRD 是集群级资源。不要在其他命名空间同时启动第二套 Kilo DaemonSet。
- `agent1` 通过 `ens18` 到达 `172.16.1.3/32`，Kilo 隧道接口为 `kilo0`。该节点的 `FORWARD` 默认策略为 `DROP`。Kilo 已为这个目标生成 MASQUERADE 规则，但仍需放行转发及已建立连接的回程：

  ```sh
  iptables -I FORWARD 1 -i kilo0 -o ens18 -d 172.16.1.3/32 -j ACCEPT
  iptables -I FORWARD 2 -i ens18 -o kilo0 -s 172.16.1.3/32 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ```

- 以上规则已在 `agent1` 运行时应用；重启或防火墙重建后可能丢失。重加前先用 `iptables -S FORWARD` 检查，避免重复插入。迁移或重启后，从 `server1` 核对 `ip route get 172.16.1.3` 应为 `via 10.4.0.2 dev kilo0`，并实际测试目标服务连通性。
