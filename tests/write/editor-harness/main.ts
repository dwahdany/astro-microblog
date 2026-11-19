import { mount } from 'svelte';
import '../../../src/write/theme/index.css';
import Harness from './Harness.svelte';

mount(Harness, { target: document.getElementById('app')! });
