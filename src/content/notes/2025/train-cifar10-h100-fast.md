---
slug: train-cifar10-h100-fast
title: ''
created: 2025-12-06T23:04:00+01:00
tags:
  - ai
  - training
  - gpu
is_draft: false
---
With [Fast Forward Computer Vision (ffcv)](https://github.com/libffcv/ffcv) you can train a classifier on CIFAR-10 on an H100 in \~14 seconds. They report in [their CIFAR-10 example](https://docs.ffcv.io/ffcv_examples/cifar10.html):

> 92.6% accuracy in 36 seconds on a single NVIDIA A100 GPU.

ffcv achieves that by speeding up the data loading with various techniques, so you can re-use most of your training code and just replace the loading, as this example from the [quickstart](https://docs.ffcv.io/quickstart.html) shows:

```python
from ffcv.loader import Loader, OrderOption
from ffcv.transforms import ToTensor, ToDevice, ToTorchImage, Cutout
from ffcv.fields.decoders import IntDecoder, RandomResizedCropRGBImageDecoder

# Random resized crop
decoder = RandomResizedCropRGBImageDecoder((224, 224))

# Data decoding and augmentation
image_pipeline = [decoder, Cutout(), ToTensor(), ToTorchImage(), ToDevice(0)]
label_pipeline = [IntDecoder(), ToTensor(), ToDevice(0)]

# Pipeline for each data field
pipelines = {
    'image': image_pipeline,
    'label': label_pipeline
}

# Replaces PyTorch data loader (`torch.utils.data.Dataloader`)
loader = Loader(write_path, batch_size=bs, num_workers=num_workers,
                order=OrderOption.RANDOM, pipelines=pipelines)

# rest of training / validation proceeds identically
for epoch in range(epochs):
    ...
```
