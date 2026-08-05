import nodes from './nodes';
import marks from './marks';
import { Schema } from 'prosemirror-model';

export const schemaNodes = nodes;
export const schemaMarks = marks;
export const textSchema = new Schema({ nodes: schemaNodes, marks: schemaMarks });
