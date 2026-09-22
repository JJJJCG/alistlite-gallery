package drivers

// AListLite 精简版：只保留本地存储、SMB、SFTP、WebDAV 四种驱动。
// 其余驱动目录已删除，请勿在此处重新引入，否则同步会上来的驱动依赖会一起被拉回来。
import (
	_ "github.com/OpenListTeam/OpenList/v4/drivers/local"
	_ "github.com/OpenListTeam/OpenList/v4/drivers/sftp"
	_ "github.com/OpenListTeam/OpenList/v4/drivers/smb"
	_ "github.com/OpenListTeam/OpenList/v4/drivers/webdav"
)

// All do nothing,just for import
// same as _ import
func All() {
}
