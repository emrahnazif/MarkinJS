# MarkinJS Examples

This directory contains various examples showcasing MarkinJS's capabilities for different use cases.

## Available Examples

### 📖 [Interactive Demo](./index.html)
Complete interactive demo showcasing all MarkinJS features:
- All annotation types (bounding boxes, polygons, keypoints)
- Zoom and pan: pinch, Ctrl / Cmd + wheel, drags, keys and buttons
- Real-time event logging and coordinate tracking
- API demonstrations and code examples
- Interactive controls and configuration options

**Perfect for**: Getting started, exploring all features, API reference

### 📚 [API Documentation](./api.html)
Comprehensive API reference with examples:
- Method documentation
- Event system details
- Configuration options
- Integration examples

**Perfect for**: Development reference, API exploration

## Quick Start

1. **Choose an example** based on your use case
2. **Open the HTML file** in your browser
3. **Start editing** - click an annotation, then drag it, its corners, its vertices or its keypoints
4. **Zoom in** - pinch, or hold Ctrl / Cmd and scroll; then drag the empty canvas to move around
5. **Read the data** in the "Annotations" panel: it is what the `change` event hands to your app

## File Structure

```
examples/
├── index.html           # Interactive demo with all features
├── api.html             # API documentation and examples
├── assets/              # Shared resources
│   ├── css/            # Stylesheets
│   ├── images/         # Sample images
│   └── js/             # Third-party libraries
└── README.md           # This file
```

## Running Examples Locally

### Option 1: Direct File Opening
Simply open any `.html` file in your web browser.

### Option 2: Local Server (Recommended)
For better performance and to avoid CORS issues:

```bash
# Using Python
python -m http.server 8000

# Using Node.js
npx serve .

# Using PHP
php -S localhost:8000
```

Then visit `http://localhost:8000/examples/`

## Customizing Examples

All examples are self-contained and can be easily customized:

1. **Modify the HTML** to change layout and controls
2. **Update the JavaScript** to add new features or change behavior  
3. **Adjust the CSS** for different styling
4. **Change the image** by replacing files in `assets/images/`

## Use Case Guides

### For Computer Vision Research
- Start with [Interactive Demo](./index.html)
- Modify classes to match your dataset categories
- Convert the annotation list to the format your ML framework expects

### For Medical Imaging
- Use [Interactive Demo](./index.html) as foundation
- Add medical-specific annotation types (measurements, regions)
- Implement DICOM coordinate handling

### For UI/UX Prototyping
- Begin with [Interactive Demo](./index.html)
- Customize interface for your workflow
- Add project-specific export formats

## Integration Examples

### React Component

When a framework owns the `<img>`, render the overlay SVG yourself and give MarkinJS the SVG.
`destroy()` in the cleanup makes it safe under React Strict Mode.

```jsx
import { useEffect, useRef } from 'react';
import MarkinJS from 'markinjs';

function AnnotationEditor({ imageUrl, width, height, annotations, onChange }) {
  const svgRef = useRef(null);

  useEffect(() => {
    const editor = MarkinJS.create(svgRef.current, { annotations });
    editor.on('change', onChange);
    return () => editor.destroy();
  }, [imageUrl]);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <img src={imageUrl} alt="" />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
    </div>
  );
}
```

`width` and `height` are the image's natural size in pixels.

### Vue Component

```vue
<template>
  <div style="position: relative; display: inline-block">
    <img :src="imageUrl" alt="" />
    <svg
      ref="overlay"
      :viewBox="`0 0 ${width} ${height}`"
      style="position: absolute; inset: 0; width: 100%; height: 100%"
    />
  </div>
</template>

<script>
import MarkinJS from 'markinjs';

export default {
  props: ['imageUrl', 'width', 'height', 'annotations'],
  emits: ['change'],
  mounted() {
    this.editor = MarkinJS.create(this.$refs.overlay, { annotations: this.annotations });
    this.editor.on('change', (annotations) => this.$emit('change', annotations));
  },
  beforeUnmount() {
    this.editor.destroy();
  }
};
</script>
```

## Contributing Examples

Have a great use case or example to share? We'd love to include it!

1. **Create your example** following the existing structure
2. **Add documentation** explaining the use case
3. **Submit a pull request** with your addition

## Getting Help

- 📧 **Questions**: markinjs@datamarkin.com
- 🐛 **Issues**: [GitHub Issues](https://github.com/emrahnazif/MarkinJS/issues)
- 📖 **Documentation**: [README](../README.md) and [API page](./api.html)

## License

All examples are released under the MIT License, same as MarkinJS.