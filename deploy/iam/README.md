# VPS 用の IAM ユーザー `serversystem-vps`

Rust（`Ec2Backend`）が使う AWS の権限。考え方は [11 の「AWS の IAM ユーザー」](../../document/renewal/11_vps_operations.md#iam)。
`serversystem-vps-policy.json` は、リポジトリが公開なので、アカウント ID などを**置き換え前の文字**で書いてある。
作るときに CloudShell で置き換える。

| 置き換える文字 | 入れる値 |
|---|---|
| `ACCOUNT_ID` | AWS のアカウント ID（12 桁） |
| `LAUNCH_TEMPLATE_ID` | Minecraft の起動テンプレートの ID（VPS の `EC2_LT_MINECRAFT` と同じ `lt-...`） |
| `HOSTED_ZONE_ID` | Minecraft の DNS 名を管理している Route 53 のホストゾーン ID（VPS の `ROUTE53_HOSTED_ZONE_ID` と同じ。`Z...`）。DNS を書き換えないなら `UpsertMinecraftRecord` の文ごと消す |
| `MINECRAFT_DNS_NAME` | Minecraft につなぐ名前（VPS の `MINECRAFT_DNS_NAME` と同じ。小文字・末尾の `.` なし。例 `mc.valolbeta.com`） |
| `ROLE_NAME` | 起動テンプレートに付いているインスタンスプロファイルのロール名。付いていなければ `PassGameServerRole` の文ごと消す |

各文の意味:

| Sid | 許すこと |
|---|---|
| `DescribeInstances` | インスタンスの一覧（リソースで絞れない操作） |
| `RunFromMinecraftTemplate` | Minecraft の起動テンプレートを使った起動だけ（`ec2:LaunchTemplate` の条件。テンプレートを使わない起動や、ほかのテンプレートからの起動はできない） |
| `TagOnLaunchOnly` | 起動と同時のタグ付けだけ（あとからタグを書き換えて、終了の制限をすり抜けることはできない） |
| `TerminateMinecraftOnly` | `Name=minecraft` のタグが付いたインスタンスの終了だけ |
| `UpsertMinecraftRecord` | そのホストゾーンの `MINECRAFT_DNS_NAME` の A レコードを UPSERT することだけ（`ForAllValues` の条件で、ほかの名前・ほかの種類・削除はできない）。起動のたびに変わる公開 IP を、いつもの名前に反映するため |
| `PassGameServerRole` | 起動テンプレートのインスタンスプロファイルのロールを EC2 に渡すことだけ |

Lightsail を操作する権限は付けない。

## 作る手順（CloudShell・東京リージョン）

### 1. 起動テンプレートを確かめる

```bash
LT=lt-xxxxxxxxxxxxxxxxx   # VPS の EC2_LT_MINECRAFT と同じ値
aws sts get-caller-identity --query Account --output text
aws ec2 describe-launch-template-versions --launch-template-id "$LT" --versions '$Latest' \
  --query 'LaunchTemplateVersions[0].LaunchTemplateData.{Image:ImageId,Type:InstanceType,Profile:IamInstanceProfile,Tags:TagSpecifications}'
```

`Profile` に `Arn` か `Name` があれば、そのインスタンスプロファイルのロール名を調べる:

```bash
aws iam get-instance-profile --instance-profile-name <プロファイル名> --query 'InstanceProfile.Roles[].RoleName' --output text
```

### 2. ポリシーを作る

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ROLE=<ロール名>   # プロファイルが無ければ空のままにする
ZONE=Z0123456789ABC          # VPS の ROUTE53_HOSTED_ZONE_ID と同じ値
DNS_NAME=mc.valolbeta.com    # VPS の MINECRAFT_DNS_NAME と同じ値
curl -fsSL https://raw.githubusercontent.com/odamag/valol-serverSystem/main/deploy/iam/serversystem-vps-policy.json \
  | sed -e "s/ACCOUNT_ID/$ACCOUNT/g" -e "s/LAUNCH_TEMPLATE_ID/$LT/g" -e "s/ROLE_NAME/$ROLE/g" \
        -e "s/HOSTED_ZONE_ID/$ZONE/g" -e "s/MINECRAFT_DNS_NAME/$DNS_NAME/g" > policy.json
# プロファイルが無いときだけ:
# jq 'del(.Statement[] | select(.Sid == "PassGameServerRole"))' policy.json > p && mv p policy.json
# DNS を書き換えないときだけ:
# jq 'del(.Statement[] | select(.Sid == "UpsertMinecraftRecord"))' policy.json > p && mv p policy.json
grep -E 'ACCOUNT_ID|LAUNCH_TEMPLATE_ID|ROLE_NAME|HOSTED_ZONE_ID|MINECRAFT_DNS_NAME' policy.json || echo 置き換え済み
aws iam create-policy --policy-name serversystem-vps --policy-document file://policy.json
aws iam create-user --user-name serversystem-vps
aws iam attach-user-policy --user-name serversystem-vps --policy-arn "arn:aws:iam::$ACCOUNT:policy/serversystem-vps"
aws iam create-access-key --user-name serversystem-vps
```

最後のコマンドが出す `AccessKeyId` と `SecretAccessKey` は、この画面でしか見られない。
VPS の `/etc/serversystem/env` の `AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY` に入れ、`sudo systemctl restart serversystem`。
CloudShell の `policy.json` は消してよい（秘密は入っていない）。

### 2'. すでに作ってあるポリシーに `UpsertMinecraftRecord` を足す（更新）

ポリシーを作ったあとで DNS の書き換えを足すときの手順。手順 2 と同じ置き換えをした `policy.json` を作り直し、新しい版にして既定にする。
curl は main のファイルを取るので、この変更が main にマージされてから流す。
（管理ポリシーは最大 5 版まで。いっぱいなら古い版を `aws iam delete-policy-version` で消す。）

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
# LT・ROLE・ZONE・DNS_NAME を手順 2 と同じ値で入れてから、手順 2 の curl | sed で policy.json を作り直す
aws iam create-policy-version --policy-arn "arn:aws:iam::$ACCOUNT:policy/serversystem-vps" \
  --policy-document file://policy.json --set-as-default
```

そのあと VPS の `/etc/serversystem/env` に `MINECRAFT_DNS_NAME` と `ROUTE53_HOSTED_ZONE_ID` を足し、`sudo systemctl restart serversystem`。
Minecraft を起動して、状態が `running` になると、名前の A レコード（TTL 60）が公開 IP に書き換わる（`dig mc.valolbeta.com` で確かめる）。

### 3. `--dry-run` で確かめる（新しいキーで）

CloudShell で、新しいキーを**その場の変数だけ**に入れて流す（`aws configure` には保存しない）。

```bash
export AWS_ACCESS_KEY_ID=<新しいキー> AWS_SECRET_ACCESS_KEY=<新しい秘密> AWS_SESSION_TOKEN=
aws sts get-caller-identity --query Arn --output text   # .../user/serversystem-vps と出る
```

| # | コマンド | 期待する結果 |
|---|---|---|
| 1 | `aws ec2 describe-instances --dry-run` | `DryRunOperation`（許されている） |
| 2 | 下の「起動」 | `DryRunOperation` |
| 3 | `aws ec2 run-instances --dry-run --image-id <手順 1 の Image> --instance-type t3.micro` | `UnauthorizedOperation`（テンプレートを使わない起動はできない） |
| 4 | `aws ec2 create-tags --dry-run --resources <どれかのインスタンス ID> --tags Key=Name,Value=minecraft` | `UnauthorizedOperation`（あとからのタグ付けはできない） |
| 5 | `minecraft` 以外のインスタンスがあれば `aws ec2 terminate-instances --dry-run --instance-ids <その ID>` | `UnauthorizedOperation` |

起動（Rust と同じ指定）:

```bash
aws ec2 run-instances --dry-run \
  --launch-template "LaunchTemplateId=$LT,Version=\$Latest" \
  --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time","InstanceInterruptionBehavior":"terminate"}}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=minecraft},{Key=GameStatus,Value=Booting}]'
```

終わったら `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN` で CloudShell 自身の権限に戻す。

`UnauthorizedOperation` になるはずのところで止まらない、または `DryRunOperation` になるはずのところで `UnauthorizedOperation` になったときは、
エラーに付く `Encoded authorization failure message` を `aws sts decode-authorization-message --encoded-message <文字列>`（CloudShell 自身の権限で）で読み、ポリシーを直す。
