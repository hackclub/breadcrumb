#!/usr/bin/env python3
"""Build the native binaries Tauri bundles. No capture or library access occurs here."""
from pathlib import Path
import argparse,os,platform,subprocess,sys
root=Path(__file__).resolve().parent.parent
os.chdir(root)
target=subprocess.check_output(['rustc','-vV'],text=True).split('host: ')[1].splitlines()[0]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--target',choices=['aarch64-apple-darwin','x86_64-apple-darwin'])
requested=parser.parse_args().target
if requested and sys.platform!='darwin':parser.error('macOS cross-builds require macOS')
if requested:target=requested
suffix='.exe' if os.name=='nt' else ''
folder=root/'desktop/src-tauri/binaries';folder.mkdir(parents=True,exist_ok=True)
if sys.platform=='darwin':os.environ.setdefault('MACOSX_DEPLOYMENT_TARGET','14.0')
go_env=dict(os.environ)
if requested:go_env.update(GOOS='darwin',GOARCH='arm64' if target.startswith('aarch64') else 'amd64',CGO_ENABLED='0')
subprocess.run(['go','build','-trimpath','-ldflags=-s -w','-o',str(folder/f'breadcrumb-engine-{target}{suffix}'),'./cmd/breadcrumb-engine'],cwd=root/'engine',env=go_env,check=True)
if sys.platform=='darwin':
    env=dict(os.environ)
    env.setdefault('SDKROOT',subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip())
    args=['swift','build','-c','release']
    if requested:
        arch='arm64' if target.startswith('aarch64') else 'x86_64'
        args+=['--triple',arch+'-apple-macosx14.0','--scratch-path',str(root/'.build'/('capture-'+arch))]
    subprocess.run(args+['--product','BreadcrumbCapture'],env=env,check=True)
    binary=Path(subprocess.check_output(args+['--show-bin-path'],env=env,text=True).strip())/'BreadcrumbCapture'
else:
    subprocess.run(['cargo','build','--release','--locked','--manifest-path','native/capture/Cargo.toml'],check=True)
    binary=root/'native/capture/target/release'/('breadcrumb-capture'+suffix)
import shutil
shutil.copy2(binary,folder/f'breadcrumb-capture-{target}{suffix}')
print('Prepared capture and engine binaries for '+target)
