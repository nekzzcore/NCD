const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
async function simplifier(){
 const THREE=await import('three');const source=fs.readFileSync(path.join(__dirname,'../health-3d.js'),'utf8');
 const context={THREE};vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('    function simplifyStaticGeometry('),source.indexOf('    function initHealth3D('))+'\nthis.simplify=simplifyStaticGeometry;',context);
 return {THREE,simplify:context.simplify};
}
test('Static geometry is reduced within budget with finite normals, valid indices and preserved bounds',async()=>{
 const {THREE,simplify}=await simplifier();const original=new THREE.SphereGeometry(1,256,128),before=original.index.count;
 const result=simplify(original,6000);
 assert.notEqual(result,original);assert.ok(result.index.count/3<=6000);assert.equal(original.index.count,before);
 assert.ok(result.attributes.position.count<original.attributes.position.count);
 for(const index of result.index.array)assert.ok(index>=0&&index<result.attributes.position.count);
 for(const normal of result.attributes.normal.array)assert.ok(Number.isFinite(normal));
 const size=result.boundingBox.getSize(new THREE.Vector3());for(const extent of [size.x,size.y,size.z])assert.ok(extent>1.9&&extent<=2.001);
 assert.ok(result.boundingSphere.radius>0.95&&result.boundingSphere.radius<=1.03);
 result.dispose();original.dispose();
});
test('Small meshes retain original geometry and non-indexed geometry can be simplified',async()=>{
 const {THREE,simplify}=await simplifier();const small=new THREE.BoxGeometry();assert.equal(simplify(small,100),small);
 const dense=new THREE.SphereGeometry(1,128,64).toNonIndexed(),result=simplify(dense,1500);
 assert.ok(result.index.count/3<=1500);assert.ok(result.attributes.normal);small.dispose();dense.dispose();result.dispose();
});
