"""Normalize tagged input artwork to sRGB; printer correction stays in the driver."""
from io import BytesIO
from PIL import ImageCms
SRGB_PROFILE=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
def to_srgb(image):
    image.load()
    profile=image.info.get('icc_profile')
    if not profile:return image.convert('RGBA' if image.mode=='RGBA' else 'RGB')
    source=ImageCms.ImageCmsProfile(BytesIO(profile))
    return ImageCms.profileToProfile(image,source,ImageCms.createProfile('sRGB'),outputMode='RGBA' if image.mode=='RGBA' else 'RGB')

def is_srgb(image):
    profile=image.info.get('icc_profile')
    if not profile:return True
    return ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(BytesIO(profile))).strip().lower() in ('srgb built-in','srgb iec61966-2.1')
