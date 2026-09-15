// Render original/optimized pairs in Cesium using installed Edge (headless).
// Usage: node scripts/verify-scene-models.mjs <tool-directory>
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const requireTool = createRequire(path.join(path.resolve(process.argv[2]), 'package.json'));
const { chromium } = requireTool('playwright');
const reportDir = path.join(project, 'docs/model-optimization');
await fs.mkdir(reportDir, { recursive: true });
const html = `<!doctype html><html><head><meta charset="utf-8"><script>window.CESIUM_BASE_URL='/cesium/';</script>
<script src="/cesium/Cesium.js"></script><link rel="stylesheet" href="/cesium/Widgets/widgets.css">
<style>body{margin:0;background:#202b3e;color:#fff;font:18px Arial}header{padding:16px 24px}main{display:flex}.panel{width:50%}.label{padding:10px 24px}.viewer{height:560px}.cesium-widget-credits{display:none!important}</style></head>
<body><header id="title"></header><main><div class="panel"><div class="label">Original</div><div class="viewer" id="a"></div></div><div class="panel"><div class="label">Optimized</div><div class="viewer" id="b"></div></div></main><script>
window.result = null;
window.runComparison = async (name) => {
document.querySelector('#title').textContent = name + ' — same camera, scale and lighting';
const viewers=[]; const models=[];
for (const [index,id] of ['a','b'].entries()) {
const viewer=new Cesium.Viewer(id,{baseLayer:false,globe:false,skyBox:false,skyAtmosphere:false,sun:false,moon:false,
animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,
navigationHelpButton:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,requestRenderMode:false});
viewer.scene.backgroundColor=Cesium.Color.fromCssColorString('#27344b');
viewer.scene.light=new Cesium.DirectionalLight({direction:new Cesium.Cartesian3(-1,-1,-2),intensity:2.5});
viewer.scene.renderError.addEventListener((scene,error)=>{ window.renderErrors.push(String(error)); });
const model=await Cesium.Model.fromGltfAsync({url:'/pictures/'+name+(index?'-optimized-v1':'')+'.glb',incrementallyLoadTextures:false,
environmentMapOptions:{enabled:false},imageBasedLighting:new Cesium.ImageBasedLighting({imageBasedLightingFactor:new Cesium.Cartesian2(0,0)})});
viewer.scene.primitives.add(model); viewers.push(viewer); models.push(model);
}
await Promise.all(models.map(m=>m.ready?Promise.resolve():new Promise(resolve=>m.readyEvent.addEventListener(resolve))));
const sphere=models[0].boundingSphere;
for(const viewer of viewers) {
viewer.camera.viewBoundingSphere(sphere,new Cesium.HeadingPitchRange(0.65,-0.4,sphere.radius*2.8));
viewer.scene.light.direction=Cesium.Cartesian3.clone(viewer.camera.directionWC);
}
window.result=models.map(m=>({ready:m.ready,radius:m.boundingSphere.radius,center:m.boundingSphere.center}));
}; window.renderErrors=[];
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type','text/html'); res.end(html); return; }
    const isCesium = url.pathname.startsWith('/cesium/');
    const root = isCesium ? path.join(project,'node_modules/cesium/Build/Cesium') : path.join(project,'public');
    const relative = decodeURIComponent(isCesium ? url.pathname.slice(8) : url.pathname.slice(1));
    const target=path.resolve(root,relative);
    if(!target.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
    const types={'.js':'application/javascript','.css':'text/css','.wasm':'application/wasm','.glb':'model/gltf-binary','.json':'application/json'};
    res.setHeader('Content-Type',types[path.extname(target)]||'application/octet-stream');
    res.end(await fs.readFile(target));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
  const results=[];
  for(const name of ['aircraft-v1','radar','tdrs','ground-station']) {
    const page=await browser.newPage({viewport:{width:1440,height:660},deviceScaleFactor:1});
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(name=>{window.runComparison(name).catch(error=>{window.result={error:String(error)}});},name);
    await page.waitForFunction(()=>window.result!==null,{},{timeout:120000});
    // Allow textures and the camera change to reach the captured frame.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const result=await page.evaluate(()=>({models:window.result,errors:window.renderErrors}));
    if(errors.length||result.errors.length||result.models.error) throw new Error(JSON.stringify({name,...result,errors}));
    await page.screenshot({path:path.join(reportDir,name+'-comparison.png')});
    results.push({name,...result});console.log(JSON.stringify({name,...result}));
    await page.close();
  }
  await fs.writeFile(path.join(reportDir,'cesium-validation.json'),JSON.stringify(results,null,2));
} finally {await browser?.close();server.close();}
