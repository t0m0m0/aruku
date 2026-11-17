import { b } from './cycle-b';

export interface A {
  readonly b: typeof b;
}
