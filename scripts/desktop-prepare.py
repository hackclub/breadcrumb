#!/usr/bin/env python3
"""Build the native binaries Tauri bundles. No capture or library access occurs here."""
from pathlib import Path
import os,platform,subprocess,sys
root=Path(__file__).resolve().parent.parent
os.chdir(root)
target=subprocess.check_output(['rustc','-vV'],text=True).split('host: ')[1].splitlines()[0]
suffix='.exe' if os.name=='nt' else ''
folder=root/'desktop/src-tauri/binaries';folder.mkdir(parents=True,exist_ok=True)
if sys.platform=='darwin':os.environ.setdefault('MACOSX_DEPLOYMENT_TARGET','14.0')
subprocess.run(['go','build','-trimpath','-o',str(folder/f'breadcrumb-engine-{target}{suffix}'),'./cmd/breadcrumb-engine'],cwd=root/'engine',check=True)
if sys.platform=='darwin':
    env=dict(os.environ)
    env.setdefault('SDKROOT',subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip())
    subprocess.run(['swift','build','-c','release','--product','BreadcrumbCapture'],env=env,check=True)
    binary=Path(subprocess.check_output(['swift','build','-c','release','--show-bin-path'],env=env,text=True).strip())/'BreadcrumbCapture'
else:
    subprocess.run(['cargo','build','--release','--locked','--manifest-path','native/capture/Cargo.toml'],check=True)
    binary=root/'native/capture/target/release'/('breadcrumb-capture'+suffix)
import shutil
shutil.copy2(binary,folder/f'breadcrumb-capture-{target}{suffix}')
print('Prepared capture and engine binaries for '+target)
