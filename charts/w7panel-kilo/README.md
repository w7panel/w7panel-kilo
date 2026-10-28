# w7panel-kilo

Installs Kilo 0.7.0 on k3s with Cilium using Kilo's CNI compatibility mode. The chart includes the Peer CRD, RBAC, kubeconfig generation, and a privileged Kilo DaemonSet. It does not replace Cilium's CNI files.

```sh
helm install kilo ./charts/w7panel-kilo --namespace kube-system
kubectl -n kube-system rollout status daemonset/kilo
```

Set `image.repository` and `image.tag` if the nodes pull Kilo from a mirror. Both the main and init containers use the same image.

Install into a new cluster only after confirming it uses k3s and Cilium. If Kilo was already installed with `kubectl apply`, Helm cannot take ownership of its existing resources automatically; plan an adoption or migration before installing this release. Helm also does not upgrade or remove CRDs placed under `crds/`.
