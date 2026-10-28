build-ui:
	npm run build
	cd dist && zip -r -FS dist.zip ./*

publish-kilo:
# 	zpk login --username=w7admin --password=${ZPK_IDC_PASSWORD} --host=zpk.fan.b2.sz.w7.com
	zpk use --name=w7panel-kilo
	zpk attach add --path=./dist/dist.zip --type=frontend
	zpk push
