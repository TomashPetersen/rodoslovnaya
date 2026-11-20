export type LifeStatus = 'unknown' | 'alive' | 'deceased';

export interface Person {
  id: string;
  name: string;
  birthDate: string;
  deathDate: string;
  birthPlace: string;
  lifeStatus: LifeStatus;
  biography: string;
  source: string;
  portraitId?: string;
}

export interface Relationship {
  id: string;
  fromId: string;
  toId: string;
  kind: 'biological' | 'adoptive' | 'partner';
  status?: 'together' | 'separated';
}

export interface Story {
  id: string;
  title: string;
  text: string;
  peopleIds: string[];
}

export interface Media {
  id: string;
  name: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  size: number;
  caption: string;
  peopleIds: string[];
}

export type TrashKind = 'person' | 'relationship' | 'media' | 'story';

export interface TrashGroup {
  id: string;
  deletedAt: string;
  kind: TrashKind;
  entityId: string;
  relationshipIds: string[];
}

export interface FamilyProject {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  people: Person[];
  relationships: Relationship[];
  stories: Story[];
  media: Media[];
  trash: TrashGroup[];
  restoredFrom?: { projectId: string; createdAt: string };
}

export type LegacyFamilyProject = Omit<FamilyProject, 'trash'>;

export interface BackupStatus {
  projectId: string;
  revision: number;
  createdAt: string;
  sha256: string;
  confirmed: boolean;
  verifiedAt?: string;
}

export interface StoredFile {
  id: string;
  projectId: string;
  original: Blob;
  thumbnail?: Blob;
}

export interface ProjectSnapshot {
  project: FamilyProject;
  files: StoredFile[];
}

export function newPerson(name: string): Person {
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    birthDate: '',
    deathDate: '',
    birthPlace: '',
    lifeStatus: 'unknown',
    biography: '',
    source: '',
  };
}
