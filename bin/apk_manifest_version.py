"""Update only Android's version attributes in an existing binary XML manifest."""
import struct

def update_manifest_version(original, version_code, version_name):
    data=bytearray(original)
    if struct.unpack_from('<HH',data,0)!=(3,8):raise ValueError('Not binary XML')
    pool=None;strings=[];position=8
    while position<len(data):
        kind,header,size=struct.unpack_from('<HHI',data,position)
        if not size or position+size>len(data):raise ValueError('Invalid XML chunk')
        if kind==1:
            if header!=28:raise ValueError('Unexpected string pool header')
            count,styles,flags,start,style_start=struct.unpack_from('<IIIII',data,position+8)
            if styles or style_start:raise ValueError('Styled manifests are not supported')
            offsets=list(struct.unpack_from('<'+'I'*count,data,position+28))
            utf8=bool(flags&0x100)
            for offset in offsets:
                p=position+start+offset
                if utf8:
                    def length_at(index):
                        n=data[index];index+=1
                        if n&128:n=((n&127)<<8)|data[index];index+=1
                        return n,index
                    _,p=length_at(p);length,p=length_at(p)
                    strings.append(bytes(data[p:p+length]).decode('utf8'))
                else:
                    length=struct.unpack_from('<H',data,p)[0];p+=2
                    if length&0x8000:length=((length&0x7fff)<<16)|struct.unpack_from('<H',data,p)[0];p+=2
                    strings.append(bytes(data[p:p+length*2]).decode('utf-16le'))
            pool=(position,size,count,flags,start,offsets,utf8)
        elif kind==0x102:
            namespace,name,attr_start,attr_size,attr_count=struct.unpack_from('<IIHHH',data,position+16)
            if strings[name]=='manifest':
                found=set()
                for i in range(attr_count):
                    attr=position+16+attr_start+i*attr_size
                    field=strings[struct.unpack_from('<I',data,attr+4)[0]]
                    if field=='versionCode':
                        if data[attr+15] not in (0x10,0x11):raise ValueError('Unexpected versionCode type')
                        struct.pack_into('<I',data,attr+16,version_code);found.add(field)
                    elif field=='versionName':
                        if data[attr+15]!=3:raise ValueError('Unexpected versionName type')
                        struct.pack_into('<I',data,attr+8,pool[2]);struct.pack_into('<I',data,attr+16,pool[2]);found.add(field)
                if found!={'versionCode','versionName'}:raise ValueError('Missing version attributes')
                break
        position+=size
    else:raise ValueError('Missing manifest element')
    position,size,count,flags,start,offsets,utf8=pool
    raw=bytes(data[position+start:position+size])
    if utf8:
        encoded=version_name.encode('utf8')
        if len(encoded)>127 or len(version_name)>127:raise ValueError('Version too long')
        entry=bytes([len(version_name),len(encoded)])+encoded+b'\0'
    else:
        entry=struct.pack('<H',len(version_name))+version_name.encode('utf-16le')+b'\0\0'
    new_start=28+(count+1)*4
    new_raw=raw+entry
    new_size=new_start+len(new_raw);padding=(-new_size)%4;new_size+=padding
    header=struct.pack('<HHIIIIII',1,28,new_size,count+1,0,flags&~1,new_start,0)
    new_pool=header+struct.pack('<'+'I'*(count+1),*(offsets+[len(raw)]))+new_raw+b'\0'*padding
    result=data[:position]+new_pool+data[position+size:]
    struct.pack_into('<I',result,4,len(result))
    return bytes(result)
