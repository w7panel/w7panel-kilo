build-ui:
	npm run build
	cd dist && zip -r -FS dist.zip ./*

packageHelm:
	helm package ./charts/w7panel-kilo --app-version ${CNB_BRANCH} --version ${CNB_BRANCH} 

publish-kilo:
# 	zpk login --username=w7admin --password=${ZPK_IDC_PASSWORD} --host=zpk.fan.b2.sz.w7.com
	zpk login --username=w7admin --password=${PASSWORD} --host=zpk.w7.cc
	zpk use --name=w7panel-kilo
	zpk attach add --path=./w7panel-kilo-${CNB_BRANCH}.tgz --type=helm
	zpk attach add --path=./dist/dist.zip --type=frontend
	zpk push

publish:
	make build-ui
	make packageHelm
	make publish-kilo