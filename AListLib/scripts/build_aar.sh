cd ../sources
# 已移除 alitvlib（TV 端阿里云盘令牌服务），AAR 只打包 alistlib
gomobile bind -ldflags "-s -w" -v -androidapi 21 "github.com/OpenListTeam/OpenList/v4/alistlib"
mkdir -p ../../app/libs/
cp -f ./alistlib.aar ../../app/libs/
